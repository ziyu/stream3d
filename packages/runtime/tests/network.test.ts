import { afterEach, describe, expect, it, vi } from 'vitest';
import { NetworkMonitor } from '../src/network.js';

afterEach(() => vi.unstubAllGlobals());

async function flush() {
  for (let index = 0; index < 12; index++) await Promise.resolve();
}

function controlledBody() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; }, cancel });
  return { body, controller, cancel };
}

describe('measured fetch counters', () => {
  it('counts delivered chunks before completion and returns their exact bytes', async () => {
    const source = controlledBody();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(source.body)));
    const monitor = new NetworkMonitor();
    const operation = monitor.fetchBytes('https://example.test/asset.glb', new AbortController().signal);
    source.controller.enqueue(new Uint8Array([1, 2, 3]));
    await flush();
    expect(monitor.stats).toEqual({
      requestsStarted: 1, requestsCompleted: 0, requestsAborted: 0, requestsFailed: 0,
      requestsActive: 1, bytesReceived: 3, bytesCompleted: 0,
    });
    source.controller.enqueue(new Uint8Array([4, 5]));
    source.controller.close();
    expect(new Uint8Array(await operation)).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
    expect(monitor.stats).toEqual({
      requestsStarted: 1, requestsCompleted: 1, requestsAborted: 0, requestsFailed: 0,
      requestsActive: 0, bytesReceived: 5, bytesCompleted: 5,
    });
    const snapshot = monitor.stats;
    snapshot.bytesReceived = 999;
    expect(monitor.stats.bytesReceived).toBe(5);
  });

  it('counts partial received bytes and cancels a stalled response body on abort', async () => {
    const source = controlledBody();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(source.body)));
    const monitor = new NetworkMonitor();
    const controller = new AbortController();
    const operation = monitor.fetchBytes('https://example.test/asset.glb', controller.signal);
    const rejection = expect(operation).rejects.toMatchObject({ name: 'AbortError' });
    source.controller.enqueue(new Uint8Array(7));
    await flush();
    controller.abort();
    await rejection;
    expect(source.cancel).toHaveBeenCalledTimes(1);
    expect(monitor.stats).toEqual({
      requestsStarted: 1, requestsCompleted: 0, requestsAborted: 1, requestsFailed: 0,
      requestsActive: 0, bytesReceived: 7, bytesCompleted: 0,
    });
  });

  it('keeps received bytes from a failed body without claiming a completed download', async () => {
    const source = controlledBody();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(source.body)));
    const monitor = new NetworkMonitor();
    const operation = monitor.fetchBytes('https://example.test/asset.glb', new AbortController().signal);
    const rejection = expect(operation).rejects.toThrow('broken connection');
    source.controller.enqueue(new Uint8Array(4));
    await flush();
    source.controller.error(new Error('broken connection'));
    await rejection;
    expect(monitor.stats).toEqual({
      requestsStarted: 1, requestsCompleted: 0, requestsAborted: 0, requestsFailed: 1,
      requestsActive: 0, bytesReceived: 4, bytesCompleted: 0,
    });
  });

  it('counts HTTP failure as a failed request and releases its unread body', async () => {
    const source = controlledBody();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(source.body, { status: 503 })));
    const monitor = new NetworkMonitor();
    await expect(monitor.fetchBytes('https://example.test/asset.glb', new AbortController().signal)).rejects.toThrow('HTTP 503');
    expect(source.cancel).toHaveBeenCalledTimes(1);
    expect(monitor.stats.requestsFailed).toBe(1);
    expect(monitor.stats.bytesReceived).toBe(0);
    expect(monitor.stats.requestsActive).toBe(0);
  });

  it('does not count a request canceled before fetch is called', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const monitor = new NetworkMonitor();
    const controller = new AbortController();
    controller.abort();
    await expect(monitor.fetchBytes('https://example.test/asset.glb', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(monitor.stats.requestsStarted).toBe(0);
    expect(monitor.stats.requestsAborted).toBe(0);
  });

  it('closes a late response body after cancellation while headers were pending', async () => {
    const source = controlledBody();
    let respond!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { respond = resolve; })));
    const monitor = new NetworkMonitor();
    const controller = new AbortController();
    const operation = monitor.fetchBytes('https://example.test/asset.glb', controller.signal);
    const rejection = expect(operation).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    respond(new Response(source.body));
    await rejection;
    expect(source.cancel).toHaveBeenCalledTimes(1);
    expect(monitor.stats.requestsAborted).toBe(1);
    expect(monitor.stats.requestsActive).toBe(0);
    expect(monitor.stats.bytesReceived).toBe(0);
  });
});
