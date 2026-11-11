import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PerspectiveCamera, Scene, Texture, WebGLRenderer } from 'three';
import type { RendererBackend } from 'stream3d';
import type { Story } from '../examples/playground/src/showcase/catalog.js';

const fixture = vi.hoisted(() => ({
  apps: [] as { destroy: ReturnType<typeof vi.fn>; renderer: RendererBackend & { forceContextLoss: ReturnType<typeof vi.fn> } }[],
  sessions: [] as string[],
  failBuild: false,
  ownedRenderer: false,
  restoredAtDestroy: [] as boolean[],
  cleanup: [] as string[],
}));

vi.mock('../examples/playground/src/showcase/catalog.js', () => ({
  assets: {
    terrain: { levels: [{ url: '/terrain-preview.glb', byteLength: 10 }, { url: '/terrain-full.glb', byteLength: 100 }] },
    pavilion: { levels: [{ url: '/pavilion-preview.glb', byteLength: 20 }, { url: '/pavilion-full.glb', byteLength: 200 }] },
  },
}));

vi.mock('../examples/playground/src/showcase/controller.js', () => ({
  makeApp: vi.fn(() => {
    const render = vi.fn();
    const renderer = Object.assign(fixture.ownedRenderer ? Object.create(WebGLRenderer.prototype) : {}, {
      setSize: vi.fn(), render, dispose: vi.fn(),
      forceContextLoss: vi.fn(() => { fixture.cleanup.push('context'); }),
    });
    const app = {
      renderer,
      present: vi.fn(), destroy: vi.fn(() => {
        fixture.restoredAtDestroy.push(renderer.render === render);
        fixture.cleanup.push('app');
      }),
      diagnostics: () => ({
        estimatedGpuBytes: 300,
        network: { requestsStarted: 2, requestsCompleted: 2, requestsAborted: 0, requestsFailed: 0, requestsActive: 0, bytesReceived: 300, bytesCompleted: 300 },
      }),
    };
    fixture.apps.push(app);
    return app;
  }),
  FrameHistory: class {
    private times: number[] = [];
    sample(time: number) { this.times.push(time); }
    snapshot() { return { samples: this.times.length, p95Ms: 16, meanMs: 16, fps: 62.5 }; }
  },
}));

vi.mock('../examples/playground/src/showcase/scenes.js', () => ({
  createAssetSet: (policy: { session: string }) => { fixture.sessions.push(policy.session); return policy; },
  updateCamera: vi.fn(),
  buildScene: (_app: unknown, _story: unknown, policy: { mode: string }) => {
    if (fixture.failBuild) throw new Error('Scene setup failed');
    const levels = policy.mode === 'whole' ? [{}] : [{}, {}];
    const models = [0, 1].map(() => ({
      animation: { stop: vi.fn() }, ready: () => Promise.resolve(),
      currentLevel: levels.length - 1, pendingLevel: null, manifest: { levels }, error: null,
    }));
    return { scene: {}, essential: models, actors: models.map(model => ({ model })) };
  },
}));

import { instrumentRenderer, runComparison } from '../examples/playground/src/showcase/benchmark.js';

const story = {
  index: 0, title: 'Fixture', actors: [
    { kit: 'terrain', position: [0, 0, 0] },
    { kit: 'pavilion', position: [0, 0, 0], hero: true },
  ],
} as Story;

let clock = 0;
let rafId = 0;
let rafs: Map<number, FrameRequestCallback>;
let canvas: { clientWidth: number; clientHeight: number };
let fakeDocument: EventTarget & { visibilityState: string; baseURI: string };
let controllers: AbortController[];

async function flush() {
  for (let index = 0; index < 20; index++) await Promise.resolve();
}

async function frame() {
  clock += 16;
  const callbacks = [...rafs.values()];
  rafs.clear();
  for (const callback of callbacks) callback(clock);
  await flush();
}

function run() {
  const controller = new AbortController();
  controllers.push(controller);
  const result = runComparison({
    createCanvas: () => canvas as HTMLCanvasElement,
    story, profile: 'fast', signal: controller.signal,
    onProgress: vi.fn(), onResult: vi.fn(),
  });
  return { controller, result };
}

beforeEach(() => {
  fixture.apps = [];
  fixture.sessions = [];
  fixture.failBuild = false;
  fixture.ownedRenderer = false;
  fixture.restoredAtDestroy = [];
  fixture.cleanup = [];
  clock = 0;
  rafId = 0;
  rafs = new Map();
  controllers = [];
  canvas = { clientWidth: 800, clientHeight: 600 };
  fakeDocument = Object.assign(new EventTarget(), { visibilityState: 'visible', baseURI: 'https://example.test/' });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  vi.spyOn(Math, 'random').mockReturnValue(0);
  vi.stubGlobal('document', fakeDocument);
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('devicePixelRatio', 1);
  vi.stubGlobal('ResizeObserver', undefined);
  vi.stubGlobal('PerformanceObserver', undefined);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = ++rafId;
    rafs.set(id, callback);
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { rafs.delete(id); });
});

afterEach(async () => {
  for (const controller of controllers) controller.abort();
  await flush();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('showcase comparison lifecycle', () => {
  it('cancels promptly after highest detail is observed while endpoint RAF waits are pending', async () => {
    fixture.ownedRenderer = true;
    const { controller, result } = run();
    const rejection = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    await flush();
    await frame(); // Highest prepared condition is now settled; its two-frame wait is not.
    controller.abort();
    await rejection;
    expect(fixture.apps).toHaveLength(1);
    expect(fixture.apps[0]!.destroy).toHaveBeenCalledTimes(1);
    expect(fixture.restoredAtDestroy).toEqual([true]);
    expect(fixture.cleanup).toEqual(['app', 'context']);
    expect(fixture.apps[0]!.renderer.forceContextLoss).toHaveBeenCalledTimes(1);
    expect(rafs.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('records highest detail independently at exactly its own two-frame endpoint', async () => {
    const { result } = run();
    await flush();
    for (let index = 0; index < 6; index++) await frame();
    const report = await result;
    expect(report.trials).toHaveLength(2);
    for (const trial of report.trials) {
      expect(trial.firstUsefulMs).toBe(32);
      expect(trial.allObjectsMs).toBe(32);
      // The highest condition is first observed at 16 ms, followed by two 16 ms frames.
      expect(trial.highestDetailMs).toBe(48);
      expect(trial.frameIntervals.samples).toBe(3);
      expect(trial.phases).toEqual({
        appCreatedMs: 0, sceneCreationStartedMs: 0, sceneCreatedMs: 0, presentReturnedMs: 0,
        firstRafMs: 16, usefulPreparedMs: 0, allObjectsPreparedMs: 0, highestPreparedMs: 16,
      });
      expect(trial.resourceTiming).toEqual({ supported: false, limit: 128, dropped: 0, entries: [] });
      expect(trial.longTasks).toEqual({ supported: false, limit: 64, dropped: 0, entries: [] });
    }
    expect(report.trials[0]!.viewport).toEqual(report.trials[1]!.viewport);
    expect(fixture.apps.every(app => app.destroy.mock.calls.length === 1)).toBe(true);
    expect(fixture.apps.every(app => app.renderer.forceContextLoss.mock.calls.length === 0)).toBe(true);
    expect(rafs.size).toBe(0);
  });

  it('bounds observer records, filters trial sessions and drains pending records at completion', async () => {
    class FakePerformanceObserver {
      static supportedEntryTypes = ['resource', 'longtask'];
      static instances: FakePerformanceObserver[] = [];
      type = '';
      records: PerformanceEntry[] = [];
      disconnect = vi.fn();
      constructor(_callback: PerformanceObserverCallback) { FakePerformanceObserver.instances.push(this); }
      observe(options: PerformanceObserverInit) { this.type = options.type ?? ''; }
      takeRecords() { return this.records.splice(0); }
    }
    vi.stubGlobal('PerformanceObserver', FakePerformanceObserver);
    const { result } = run();
    await flush();
    await frame();
    const resource = (session: string, startTime: number, index = 0) => ({
      name: `https://example.test/asset-${index}.glb?labSession=${session}`,
      entryType: 'resource', startTime, duration: 3,
      fetchStart: startTime, responseStart: startTime + 1, responseEnd: startTime + 3,
      encodedBodySize: 10, decodedBodySize: 12,
    }) as PerformanceResourceTiming;
    const firstSession = fixture.sessions[0]!;
    FakePerformanceObserver.instances[0]!.records = [
      resource('another-trial', 1),
      ...Array.from({ length: 129 }, (_, index) => resource(firstSession, 10 + index / 1000, index)),
    ];
    FakePerformanceObserver.instances[1]!.records = [
      { entryType: 'longtask', startTime: -60, duration: 50 } as PerformanceEntry,
      ...Array.from({ length: 65 }, () => ({ entryType: 'longtask', startTime: -50, duration: 55 }) as PerformanceEntry),
    ];
    await frame();
    await frame(); // Second trial starts at 48 ms.
    FakePerformanceObserver.instances[2]!.records = [resource(fixture.sessions[1]!, 50)];
    for (let index = 0; index < 3; index++) await frame();
    const report = await result;

    expect(report.trials[0]!.resourceTiming.entries).toHaveLength(128);
    expect(report.trials[0]!.resourceTiming.dropped).toBe(1);
    expect(report.trials[0]!.resourceTiming.entries.every(entry => entry.url.includes(firstSession))).toBe(true);
    expect(report.trials[0]!.longTasks.entries).toHaveLength(64);
    expect(report.trials[0]!.longTasks.dropped).toBe(1);
    expect(report.trials[0]!.longTasks.entries[0]).toEqual({ startMs: -50, durationMs: 55 });
    expect(report.trials[1]!.resourceTiming).toMatchObject({ supported: true, dropped: 0, entries: [{
      startMs: 2, fetchStartMs: 2, responseStartMs: 3, responseEndMs: 5, encodedBodySize: 10, decodedBodySize: 12,
    }] });
    expect(FakePerformanceObserver.instances.every(observer => observer.disconnect.mock.calls.length === 1)).toBe(true);
  });

  it('rejects an initially hidden page before creating any app', async () => {
    fakeDocument.visibilityState = 'hidden';
    await expect(run().result).rejects.toThrow('page is hidden');
    expect(fixture.apps).toHaveLength(0);
    expect(rafs.size).toBe(0);
  });

  it.each(['size', 'pixel-ratio'] as const)('rejects a mid-trial %s change and cleans up', async change => {
    const { result } = run();
    const rejection = expect(result).rejects.toThrow('canvas size or device pixel ratio changed');
    await flush();
    await frame();
    if (change === 'size') canvas.clientWidth = 900;
    else vi.stubGlobal('devicePixelRatio', 2);
    window.dispatchEvent(new Event('resize'));
    await rejection;
    expect(fixture.apps[0]!.destroy).toHaveBeenCalledTimes(1);
    expect(rafs.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('destroys an already-created app when synchronous scene setup fails', async () => {
    fixture.failBuild = true;
    await expect(run().result).rejects.toThrow('Scene setup failed');
    expect(fixture.apps[0]!.destroy).toHaveBeenCalledTimes(1);
    expect(rafs.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('observes renderer calls without changing their receiver, result, errors or promise identity', async () => {
    clock = 100;
    const scene = new Scene();
    const camera = new PerspectiveCamera();
    const texture = new Texture();
    const result = {};
    const failure = new Error('Renderer failure');
    let reject!: (reason: unknown) => void;
    const pending = new Promise<unknown>((_resolve, no) => { reject = no; });
    let throwCompile = false;
    const renderer: RendererBackend = {
      setSize() {}, dispose() {},
      render(receivedScene, receivedCamera) {
        expect(this).toBe(renderer);
        expect([receivedScene, receivedCamera]).toEqual([scene, camera]);
        clock += 70;
        return result;
      },
      compileAsync(receivedScene, receivedCamera) {
        expect(this).toBe(renderer);
        expect([receivedScene, receivedCamera]).toEqual([scene, camera]);
        clock += 5;
        if (throwCompile) throw failure;
        return pending;
      },
      initTexture(receivedTexture) {
        expect(this).toBe(renderer);
        expect(receivedTexture).toBe(texture);
        clock += 3;
        throw failure;
      },
    };
    const originals = { render: renderer.render, compileAsync: renderer.compileAsync, initTexture: renderer.initTexture };
    const probe = instrumentRenderer(renderer, 100);
    expect(renderer.render(scene, camera)).toBe(result);
    const returned = renderer.compileAsync!(scene, camera);
    expect(returned).toBe(pending);
    expect(() => renderer.initTexture!(texture)).toThrow(failure);
    clock = 220;
    const rejection = expect(returned).rejects.toBe(failure);
    reject(failure);
    await rejection;
    expect(probe.snapshot().compileAsyncWait).toMatchObject({ count: 1, totalMs: 45, maxMs: 45 });
    throwCompile = true;
    expect(() => renderer.compileAsync!(scene, camera)).toThrow(failure);
    for (let index = 0; index < 35; index++) renderer.render(scene, camera);
    const snapshot = probe.snapshot();
    expect(snapshot.render).toEqual({ count: 36, totalMs: 2520, maxMs: 70, maxStartMs: 0 });
    expect(snapshot.compileAsyncCall).toMatchObject({ count: 2, totalMs: 10, maxMs: 5 });
    expect(snapshot.initTexture).toMatchObject({ count: 1, totalMs: 3 });
    expect(snapshot.slowCalls.entries).toHaveLength(32);
    expect(snapshot.slowCalls.dropped).toBe(4);
    expect(snapshot.slowCalls.entries[0]).toEqual({ name: 'render', startMs: 0, durationMs: 70 });
    probe.restore();
    probe.restore();
    expect(renderer.render).toBe(originals.render);
    expect(renderer.compileAsync).toBe(originals.compileAsync);
    expect(renderer.initTexture).toBe(originals.initTexture);
    renderer.render(scene, camera);
    expect(probe.snapshot().render.count).toBe(36);
    texture.dispose();
  });

  it('releases a discarded feed canvas context once after managed app teardown', async () => {
    const { FeedController } = await vi.importActual<typeof import('../examples/playground/src/showcase/controller.js')>(
      '../examples/playground/src/showcase/controller.js',
    );
    const order: string[] = [];
    const renderer = Object.assign(Object.create(WebGLRenderer.prototype), {
      forceContextLoss: vi.fn(() => order.push('context')),
    });
    const controller = Object.assign(Object.create(FeedController.prototype), {
      app: { renderer, destroy: vi.fn(() => order.push('app')) },
      bundles: new Map([[0, {}]]), generation: 0, disposed: false,
    }) as InstanceType<typeof FeedController>;
    controller.destroy();
    controller.destroy();
    expect(order).toEqual(['app', 'context']);
    expect(controller.bundles.size).toBe(0);
  });
});
