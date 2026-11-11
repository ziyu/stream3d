import type { IncomingMessage, OutgoingHttpHeader, OutgoingHttpHeaders, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { NETWORK_PROFILES, type NetworkProfileId } from './src/showcase/network-profiles.js';

export interface NetworkLabOptions {
  /** One shared bucket holds at most this many body bytes. Default: 16 KiB. */
  chunkBytes?: number;
  maxSessions?: number;
  maxResponsesPerSession?: number;
}

export interface NetworkLabStats {
  sessions: number;
  responses: number;
  queuedBytes: number;
  emittedBytes: number;
}

export interface NetworkLabMiddleware {
  (request: IncomingMessage, response: ServerResponse, next: (error?: unknown) => void): void;
  readonly stats: NetworkLabStats;
  dispose(): void;
}

type WriteCallback = (error?: Error | null) => void;
interface Segment {
  bytes: Buffer;
  offset: number;
  callback?: WriteCallback;
}
interface Flow {
  response: ServerResponse;
  sendBody: boolean;
  queue: Segment[];
  queuedBytes: number;
  eligibleAt: number;
  blocked: boolean;
  needDrain: boolean;
  ended: boolean;
  ending: boolean;
  closed: boolean;
  flushRequested: boolean;
  callbacks: Set<WriteCallback>;
  endCallback?: WriteCallback;
  write(bytes: Buffer, callback?: WriteCallback): boolean;
  end(callback?: WriteCallback): void;
  flush(): void;
  emitDrain(): void;
  close(error?: Error): void;
}
interface Session {
  id: string;
  profile: NetworkProfileId;
  flows: Flow[];
  cursor: number;
  tokens: number;
  refillAt: number;
  timer?: ReturnType<typeof setTimeout>;
  timerAt: number;
  microtaskQueued: boolean;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer`);
  return value;
}

function responseClosedError(): Error {
  return Object.assign(new Error('The shaped HTTP response closed before completion'), { code: 'ERR_STREAM_PREMATURE_CLOSE' });
}

/**
 * A development/preview middleware, deliberately independent of filesystem access.
 * Downstream Vite handlers retain responsibility for file authorization and status.
 * Each session has ONE aggregate token bucket, with round-robin response service.
 * It paces body writes; it is not a simulation of packet loss, TCP, or browser CPU.
 */
export function createNetworkLabMiddleware(options: NetworkLabOptions = {}): NetworkLabMiddleware {
  const chunkBytes = positiveInteger(options.chunkBytes ?? 16 * 1024, 'chunkBytes');
  const maxSessions = positiveInteger(options.maxSessions ?? 64, 'maxSessions');
  const maxResponses = positiveInteger(options.maxResponsesPerSession ?? 64, 'maxResponsesPerSession');
  const sessions = new Map<string, Session>();
  let disposed = false;
  let emittedBytes = 0;

  function schedule(session: Session, delay = 0): void {
    if (disposed || !session.flows.length) return;
    // Native means no artificial per-chunk timer delay. Socket backpressure still
    // yields to I/O, while this microtask coalesces synchronous downstream writes.
    if (session.profile === 'native' && delay <= 0) {
      if (session.microtaskQueued) return;
      session.microtaskQueued = true;
      queueMicrotask(() => {
        session.microtaskQueued = false;
        if (!disposed && session.flows.length) pump(session);
      });
      return;
    }
    const due = performance.now() + Math.max(0, delay);
    if (session.timer && session.timerAt <= due) return;
    if (session.timer) clearTimeout(session.timer);
    session.timerAt = due;
    session.timer = setTimeout(() => {
      session.timer = undefined;
      pump(session);
    }, Math.max(0, Math.ceil(delay)));
    session.timer.unref?.();
  }

  function pump(session: Session): void {
    if (disposed || !session.flows.length) return;
    const profile = NETWORK_PROFILES[session.profile];
    const now = performance.now();
    if (profile.bytesPerSecond !== null) {
      session.tokens = Math.min(chunkBytes, session.tokens + (now - session.refillAt) * profile.bytesPerSecond / 1000);
    }
    session.refillAt = now;
    let nextDelay = Infinity;
    let idleVisits = 0;
    let writes = 0;
    // A bounded turn also lets native transfers yield to other HTTP responses.
    while (session.flows.length && writes < 64 && idleVisits < session.flows.length) {
      session.cursor %= session.flows.length;
      const flow = session.flows[session.cursor]!;
      session.cursor = (session.cursor + 1) % session.flows.length;
      idleVisits++;
      if (flow.closed || flow.ending || flow.blocked) continue;
      if (flow.eligibleAt > now) {
        nextDelay = Math.min(nextDelay, flow.eligibleAt - now);
        continue;
      }
      if (flow.flushRequested) {
        flow.flushRequested = false;
        flow.flush();
      }
      const segment = flow.queue[0];
      if (!segment) {
        if (flow.ended) {
          flow.ending = true;
          flow.end(flow.endCallback);
        } else if (flow.needDrain) {
          flow.needDrain = false;
          flow.emitDrain();
        }
        continue;
      }
      if (!flow.sendBody || flow.response.statusCode === 204 || flow.response.statusCode === 304) {
        flow.queuedBytes -= segment.bytes.length - segment.offset;
        flow.queue.shift();
        segment.callback?.();
        writes++;
        idleVisits = 0;
        continue;
      }
      const size = Math.min(chunkBytes, segment.bytes.length - segment.offset);
      if (profile.bytesPerSecond !== null && session.tokens + 0.001 < size) {
        nextDelay = Math.min(nextDelay, (size - session.tokens) / profile.bytesPerSecond * 1000);
        continue;
      }
      if (profile.bytesPerSecond !== null) session.tokens = Math.max(0, session.tokens - size);
      const bytes = segment.bytes.subarray(segment.offset, segment.offset + size);
      segment.offset += size;
      flow.queuedBytes -= size;
      const complete = segment.offset === segment.bytes.length;
      if (complete) flow.queue.shift();
      try {
        flow.blocked = !flow.write(bytes, complete ? segment.callback : undefined);
        emittedBytes += size;
      } catch (error) {
        flow.close(error instanceof Error ? error : new Error(String(error)));
        continue;
      }
      writes++;
      idleVisits = 0;
      if (!flow.blocked && flow.needDrain && flow.queuedBytes < flow.response.writableHighWaterMark && !flow.ended) {
        flow.needDrain = false;
        flow.emitDrain();
      }
    }
    if (writes === 64) schedule(session);
    else if (Number.isFinite(nextDelay)) schedule(session, nextDelay);
  }

  function wrap(response: ServerResponse, session: Session, sendBody: boolean): void {
    const originalWrite = response.write;
    const originalEnd = response.end;
    const originalEmit = response.emit;
    const originalWriteHead = response.writeHead;
    const originalFlushHeaders = response.flushHeaders;
    const writeBody = originalWrite.bind(response);
    const endBody = originalEnd.bind(response);
    const writeHead = originalWriteHead.bind(response);
    const callbacks = new Set<WriteCallback>();
    const flow: Flow = {
      response, sendBody, queue: [], queuedBytes: 0,
      eligibleAt: performance.now() + NETWORK_PROFILES[session.profile].latencyMs,
      blocked: false, needDrain: false, ended: false, ending: false, closed: false,
      flushRequested: false, callbacks,
      write: (bytes, callback) => writeBody(bytes, callback),
      end: (callback) => { endBody(callback); },
      flush: () => originalFlushHeaders.call(response),
      emitDrain: () => { originalEmit.call(response, 'drain'); },
      close: (error) => {
        if (flow.closed) return;
        flow.closed = true;
        flow.queue.length = 0;
        flow.queuedBytes = 0;
        response.write = originalWrite;
        response.end = originalEnd;
        response.emit = originalEmit;
        response.writeHead = originalWriteHead;
        response.flushHeaders = originalFlushHeaders;
        response.removeListener('finish', onFinish);
        response.removeListener('close', onClose);
        response.removeListener('error', onError);
        const index = session.flows.indexOf(flow);
        if (index !== -1) session.flows.splice(index, 1);
        if (!session.flows.length) {
          if (session.timer) clearTimeout(session.timer);
          session.timer = undefined;
          sessions.delete(session.id);
        } else {
          schedule(session);
        }
        // Callbacks belong to writes already accepted by this response. Every one
        // settles once, including those that never reached the socket on abort.
        for (const callback of [...callbacks]) callback(error);
      },
    };
    function onFinish(): void { flow.close(); }
    function onClose(): void { flow.close(response.writableFinished ? undefined : responseClosedError()); }
    function onError(error: Error): void { flow.close(error); }
    session.flows.push(flow);
    response.on('finish', onFinish);
    response.on('close', onClose);
    response.on('error', onError);

    function tracked(callback?: WriteCallback): WriteCallback | undefined {
      if (!callback) return;
      let called = false;
      const once: WriteCallback = (error) => {
        if (called) return;
        called = true;
        callbacks.delete(once);
        callback.call(response, error);
      };
      callbacks.add(once);
      return once;
    }

    function enqueue(chunk: unknown, encoding?: BufferEncoding, callback?: WriteCallback): boolean {
      if (flow.ended || flow.closed) {
        const error = Object.assign(new Error('write after end'), { code: 'ERR_STREAM_WRITE_AFTER_END' });
        if (callback) queueMicrotask(() => callback(error));
        return false;
      }
      if (typeof chunk !== 'string' && !(chunk instanceof Uint8Array)) {
        throw new TypeError('HTTP body chunks must be strings, Buffers, or Uint8Arrays');
      }
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk, encoding) : Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      const done = tracked(callback);
      if (bytes.length) {
        flow.queue.push({ bytes, offset: 0, callback: done });
        flow.queuedBytes += bytes.length;
      } else if (done) {
        queueMicrotask(() => done());
      }
      schedule(session);
      const canContinue = !flow.blocked && flow.queuedBytes < response.writableHighWaterMark;
      if (!canContinue) flow.needDrain = true;
      return canContinue;
    }

    response.write = ((chunk: unknown, encoding?: BufferEncoding | WriteCallback, callback?: WriteCallback): boolean => {
      return enqueue(chunk, typeof encoding === 'string' ? encoding : undefined, typeof encoding === 'function' ? encoding : callback);
    }) as typeof response.write;
    response.end = ((chunk?: unknown, encoding?: BufferEncoding | WriteCallback, callback?: WriteCallback): ServerResponse => {
      if (flow.ended || flow.closed) return response;
      const done = typeof chunk === 'function' ? chunk as WriteCallback : typeof encoding === 'function' ? encoding : callback;
      if (chunk !== undefined && chunk !== null && typeof chunk !== 'function') enqueue(chunk, typeof encoding === 'string' ? encoding : undefined);
      flow.endCallback = tracked(done);
      flow.ended = true;
      schedule(session);
      return response;
    }) as typeof response.end;
    // The socket's drain cannot resume a source while our own queue is still full.
    // Deliver a downstream drain only when both buffers have room again.
    response.emit = ((event: string | symbol, ...args: unknown[]): boolean => {
      if (event !== 'drain') return originalEmit.call(response, event, ...args);
      flow.blocked = false;
      schedule(session);
      if (flow.needDrain && flow.queuedBytes < response.writableHighWaterMark && !flow.ended) {
        flow.needDrain = false;
        return originalEmit.call(response, event, ...args);
      }
      return false;
    }) as typeof response.emit;
    response.writeHead = ((status: number, messageOrHeaders?: string | Record<string, unknown> | readonly unknown[], headers?: Record<string, unknown> | readonly unknown[]): ServerResponse => {
      const message = typeof messageOrHeaders === 'string' ? messageOrHeaders : undefined;
      const supplied = message !== undefined ? headers : messageOrHeaders;
      let clean: Record<string, unknown> | unknown[] | undefined;
      if (Array.isArray(supplied)) {
        clean = [];
        for (let index = 0; index < supplied.length; index += 2) {
          if (String(supplied[index]).toLowerCase() !== 'cache-control') clean.push(supplied[index], supplied[index + 1]);
        }
        clean.push('Cache-Control', 'no-store');
      } else if (supplied && typeof supplied === 'object') {
        clean = Object.fromEntries(Object.entries(supplied).filter(([name]) => name.toLowerCase() !== 'cache-control'));
        clean['Cache-Control'] = 'no-store';
      }
      response.setHeader('Cache-Control', 'no-store');
      if (message !== undefined) return writeHead(status, message, clean as OutgoingHttpHeaders | OutgoingHttpHeader[]);
      return writeHead(status, clean as OutgoingHttpHeaders | OutgoingHttpHeader[]);
    }) as typeof response.writeHead;
    response.flushHeaders = () => {
      flow.flushRequested = true;
      schedule(session);
    };
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Stream3D-Lab-Profile', session.profile);
  }

  const middleware = ((request: IncomingMessage, response: ServerResponse, next: (error?: unknown) => void): void => {
    if (disposed) { next(); return; }
    let url: URL;
    try { url = new URL(request.url ?? '/', 'http://stream3d.local'); } catch { next(); return; }
    if (url.pathname === '/__stream3d_lab/status' && request.method === 'GET') {
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify({ enabled: true, profiles: NETWORK_PROFILES }));
      return;
    }
    if ((request.method !== 'GET' && request.method !== 'HEAD') || !url.pathname.toLowerCase().endsWith('.glb')) { next(); return; }
    const profileValues = url.searchParams.getAll('labProfile');
    const sessionValues = url.searchParams.getAll('labSession');
    const profile = profileValues[0];
    const id = sessionValues[0];
    if (profileValues.length !== 1 || sessionValues.length !== 1 || !profile || !Object.hasOwn(NETWORK_PROFILES, profile) || !id || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) { next(); return; }
    let session = sessions.get(id);
    if (session && session.profile !== profile) {
      response.writeHead(400, { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain' });
      response.end('A lab session must use one network profile.');
      return;
    }
    if ((!session && sessions.size >= maxSessions) || (session && session.flows.length >= maxResponses)) {
      response.writeHead(503, { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain', 'Retry-After': '1' });
      response.end('The local network lab is at capacity.');
      return;
    }
    if (!session) {
      session = { id, profile: profile as NetworkProfileId, flows: [], cursor: 0, tokens: 0, refillAt: performance.now(), timerAt: Infinity, microtaskQueued: false };
      sessions.set(id, session);
    }
    wrap(response, session, request.method !== 'HEAD');
    try { next(); } catch (error) { response.destroy(error instanceof Error ? error : new Error(String(error))); }
  }) as NetworkLabMiddleware;

  Object.defineProperty(middleware, 'stats', {
    get: (): NetworkLabStats => {
      const flows = [...sessions.values()].flatMap((session) => session.flows);
      return { sessions: sessions.size, responses: flows.length, queuedBytes: flows.reduce((sum, flow) => sum + flow.queuedBytes, 0), emittedBytes };
    },
  });
  middleware.dispose = (): void => {
    if (disposed) return;
    disposed = true;
    for (const session of [...sessions.values()]) {
      if (session.timer) clearTimeout(session.timer);
      for (const flow of [...session.flows]) {
        flow.response.destroy();
        flow.close(responseClosedError());
      }
    }
    sessions.clear();
  };
  return middleware;
}

/** Install before stream3d(). No shaping code is emitted into production assets. */
export function networkLab(): Plugin {
  return {
    name: 'stream3d-local-network-lab',
    configureServer(server) {
      const middleware = createNetworkLabMiddleware();
      server.middlewares.use(middleware);
      server.httpServer?.once('close', () => middleware.dispose());
    },
    configurePreviewServer(server) {
      const middleware = createNetworkLabMiddleware();
      server.middlewares.use(middleware);
      server.httpServer.once('close', () => middleware.dispose());
    },
  };
}
