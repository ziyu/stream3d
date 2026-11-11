import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Story } from '../examples/playground/src/showcase/catalog.js';

const fixture = vi.hoisted(() => ({
  apps: [] as { destroy: ReturnType<typeof vi.fn> }[],
  failBuild: false,
}));

vi.mock('../examples/playground/src/showcase/catalog.js', () => ({
  assets: {
    terrain: { levels: [{ url: '/terrain-preview.glb', byteLength: 10 }, { url: '/terrain-full.glb', byteLength: 100 }] },
    pavilion: { levels: [{ url: '/pavilion-preview.glb', byteLength: 20 }, { url: '/pavilion-full.glb', byteLength: 200 }] },
  },
}));

vi.mock('../examples/playground/src/showcase/controller.js', () => ({
  makeApp: vi.fn(() => {
    const app = {
      present: vi.fn(), destroy: vi.fn(),
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
  createAssetSet: (policy: unknown) => policy,
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

import { runComparison } from '../examples/playground/src/showcase/benchmark.js';

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
  fixture.failBuild = false;
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
    const { controller, result } = run();
    const rejection = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    await flush();
    await frame(); // Highest prepared condition is now settled; its two-frame wait is not.
    controller.abort();
    await rejection;
    expect(fixture.apps).toHaveLength(1);
    expect(fixture.apps[0]!.destroy).toHaveBeenCalledTimes(1);
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
    }
    expect(report.trials[0]!.viewport).toEqual(report.trials[1]!.viewport);
    expect(fixture.apps.every(app => app.destroy.mock.calls.length === 1)).toBe(true);
    expect(rafs.size).toBe(0);
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
});
