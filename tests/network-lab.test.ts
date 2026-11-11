import { createServer, get, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createNetworkLabMiddleware, type NetworkLabMiddleware, type NetworkLabOptions } from '../examples/playground/network-lab.js';
import { NETWORK_PROFILES } from '../examples/playground/src/showcase/network-profiles.js';

interface Laboratory {
  url: string;
  middleware: NetworkLabMiddleware;
  server: Server;
}
interface Received {
  body: Buffer;
  status: number;
  statusMessage: string;
  headers: IncomingHttpHeaders;
  elapsedMs: number;
  firstByteMs: number;
  chunks: number;
}
const laboratories: Laboratory[] = [];

async function laboratory(handler: (request: IncomingMessage, response: ServerResponse) => void, options?: NetworkLabOptions): Promise<Laboratory> {
  const middleware = createNetworkLabMiddleware(options);
  const server = createServer((request, response) => middleware(request, response, () => handler(request, response)));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const lab = { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, middleware, server };
  laboratories.push(lab);
  return lab;
}

function receive(url: string, method = 'GET'): Promise<Received> {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const request = get(url, { agent: false, method }, (response) => {
      const chunks: Buffer[] = [];
      let firstByteMs = Infinity;
      response.on('data', (chunk: Buffer) => {
        if (!chunks.length) firstByteMs = performance.now() - started;
        chunks.push(chunk);
      });
      response.once('error', reject);
      response.once('end', () => resolve({
        body: Buffer.concat(chunks), status: response.statusCode!, statusMessage: response.statusMessage!,
        headers: response.headers, elapsedMs: performance.now() - started, firstByteMs, chunks: chunks.length,
      }));
    });
    request.once('error', reject);
  });
}

afterEach(async () => {
  for (const lab of laboratories.splice(0)) {
    lab.middleware.dispose();
    lab.server.closeAllConnections();
    await new Promise<void>((resolve) => lab.server.close(() => resolve()));
  }
});

describe('local network laboratory', () => {
  it('advertises exact presets and only shapes opted-in GLB responses, preserving downstream status and headers', async () => {
    const body = Buffer.from('downstream fixture bytes');
    const lab = await laboratory((_request, response) => {
      response.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      response.writeHead(404, 'Fixture missing', {
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Content-Type': 'application/octet-stream', 'Content-Length': body.length, ETag: 'fixture-v1',
      });
      response.end(body);
    });
    const status = await receive(`${lab.url}/__stream3d_lab/status`);
    expect(JSON.parse(status.body.toString())).toEqual({ enabled: true, profiles: NETWORK_PROFILES });
    expect(status.headers['cache-control']).toBe('no-store');

    const native = await receive(`${lab.url}/asset.glb?labProfile=native&labSession=cold_1`);
    expect(native.body).toEqual(body);
    expect(native.status).toBe(404);
    expect(native.statusMessage).toBe('Fixture missing');
    expect(native.headers).toMatchObject({
      'cache-control': 'no-store', 'content-type': 'application/octet-stream', etag: 'fixture-v1',
      'content-length': String(body.length), 'x-stream3d-lab-profile': 'native',
    });
    const head = await receive(`${lab.url}/asset.glb?labProfile=native&labSession=head`, 'HEAD');
    expect(head.body.length).toBe(0);
    expect(head.headers['content-length']).toBe(String(body.length));
    expect(head.headers['cache-control']).toBe('no-store');
    for (const path of [
      '/asset.glb', '/asset.png?labProfile=slow&labSession=one',
      '/asset.glb?labProfile=slow&labSession=bad%2Ftoken',
      '/asset.glb?labProfile=slow&labProfile=native&labSession=one',
      `/asset.glb?labProfile=slow&labSession=${'x'.repeat(65)}`,
    ]) {
      const bypass = await receive(`${lab.url}${path}`);
      expect(bypass.headers['x-stream3d-lab-profile']).toBeUndefined();
      expect(bypass.headers['cache-control']).toContain('immutable');
    }
    expect(lab.middleware.stats).toMatchObject({ sessions: 0, responses: 0, queuedBytes: 0, emittedBytes: body.length });
  });

  it('paces actual body chunks after latency and propagates source backpressure and callbacks', async () => {
    const source = Buffer.alloc(160 * 1024);
    for (let index = 0; index < source.length; index++) source[index] = index % 251;
    let callbacks = 0;
    let drainEvents = 0;
    let endCallbacks = 0;
    const lab = await laboratory((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'model/gltf-binary', 'Content-Length': source.length });
      response.flushHeaders();
      let offset = 0;
      function produce(): void {
        while (offset < source.length) {
          const next = source.subarray(offset, offset + 8 * 1024);
          offset += next.length;
          if (!response.write(next, (error) => { expect(error).toBeFalsy(); callbacks++; })) return;
        }
        response.end(() => { endCallbacks++; });
      }
      response.on('drain', () => { drainEvents++; produce(); });
      produce();
    }, { chunkBytes: 8 * 1024 });
    const result = await receive(`${lab.url}/large.glb?labProfile=slow&labSession=backpressure`);
    expect(result.body).toEqual(source);
    expect(result.firstByteMs).toBeGreaterThanOrEqual(160);
    // One chunk can burst; every remaining byte must really cross the paced body.
    const minimum = 180 + (source.length - 8 * 1024) / 200_000 * 1000;
    expect(result.elapsedMs).toBeGreaterThanOrEqual(minimum * 0.9);
    expect(result.chunks).toBeGreaterThan(3);
    expect(drainEvents).toBeGreaterThan(0);
    expect(callbacks).toBe(20);
    expect(endCallbacks).toBe(1);
    expect(lab.middleware.stats).toMatchObject({ sessions: 0, responses: 0, queuedBytes: 0, emittedBytes: source.length });
  });

  it('shares one bandwidth budget across simultaneous responses in a session', async () => {
    const source = Buffer.alloc(96 * 1024, 71);
    const lab = await laboratory((_request, response) => {
      response.setHeader('Content-Length', source.length);
      response.end(source);
    });
    const started = performance.now();
    const results = await Promise.all([
      receive(`${lab.url}/a.glb?labProfile=slow&labSession=shared`),
      receive(`${lab.url}/b.glb?labProfile=slow&labSession=shared`),
    ]);
    const elapsed = performance.now() - started;
    for (const result of results) expect(result.body).toEqual(source);
    const aggregateMinimum = 180 + (source.length * 2 - 16 * 1024) / 200_000 * 1000;
    // Independent per-file rates would finish in about 590 ms and fail this gate.
    expect(elapsed).toBeGreaterThanOrEqual(aggregateMinimum * 0.9);
    expect(lab.middleware.stats.emittedBytes).toBe(source.length * 2);
    expect(lab.middleware.stats.sessions).toBe(0);
  });

  it('stops emitting and releases queued bytes and sessions when the client aborts', async () => {
    let callbackCount = 0;
    let callbackError: Error | null | undefined;
    const lab = await laboratory((_request, response) => {
      response.end(Buffer.alloc(4 * 1024 * 1024, 11), (error?: Error) => { callbackCount++; callbackError = error; });
    });
    await new Promise<void>((resolve, reject) => {
      const request = get(`${lab.url}/abort.glb?labProfile=slow&labSession=abort`, { agent: false }, (response) => {
        response.once('data', () => {
          response.destroy();
          request.destroy();
          resolve();
        });
        response.on('error', () => {});
      });
      request.once('error', reject);
    });
    await expect.poll(() => lab.middleware.stats.sessions).toBe(0);
    const emitted = lab.middleware.stats.emittedBytes;
    expect(emitted).toBeGreaterThan(0);
    expect(emitted).toBeLessThan(4 * 1024 * 1024);
    expect(lab.middleware.stats).toMatchObject({ responses: 0, queuedBytes: 0 });
    expect(callbackCount).toBe(1);
    expect(callbackError).toBeInstanceOf(Error);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(lab.middleware.stats.emittedBytes).toBe(emitted);
    lab.middleware.dispose();
    lab.middleware.dispose();
  });

  it('bounds active sessions and prevents a session from multiplying its rate by changing profiles', async () => {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const lab = await laboratory((request, response) => {
      if (request.url?.startsWith('/held.glb')) { markStarted(); return; }
      response.end('ok');
    }, { maxSessions: 1, maxResponsesPerSession: 1 });
    const held = get(`${lab.url}/held.glb?labProfile=slow&labSession=one`, { agent: false });
    held.on('error', () => {});
    await started;
    expect((await receive(`${lab.url}/asset.glb?labProfile=slow&labSession=two`)).status).toBe(503);
    expect((await receive(`${lab.url}/asset.glb?labProfile=slow&labSession=one`)).status).toBe(503);
    expect((await receive(`${lab.url}/asset.glb?labProfile=fast&labSession=one`)).status).toBe(400);
    expect(lab.middleware.stats).toMatchObject({ sessions: 1, responses: 1 });
    held.destroy();
    await expect.poll(() => lab.middleware.stats.sessions).toBe(0);
    const next = await receive(`${lab.url}/asset.glb?labProfile=native&labSession=two`);
    expect(next.status).toBe(200);
    expect(next.body.toString()).toBe('ok');
  });
});
