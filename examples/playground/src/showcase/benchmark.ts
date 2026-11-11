import { assets, type Story } from './catalog.js';
import { FrameHistory, makeApp } from './controller.js';
import { NETWORK_PROFILES, type NetworkProfileId } from './network-profiles.js';
import { buildScene, createAssetSet, updateCamera, type LoadingMode } from './scenes.js';
import type { StreamApp } from 'stream3d';

type Network = ReturnType<StreamApp['diagnostics']>['network'];
export interface TrialViewport {
  width: number;
  height: number;
  pixelRatio: number;
  devicePixelRatio: number;
}
export interface TrialResult {
  mode: LoadingMode;
  firstUsefulMs: number;
  allObjectsMs: number;
  highestDetailMs: number;
  bytesAtFirstUseful: number;
  network: Network;
  peakResidentBytes: number;
  frameIntervals: ReturnType<FrameHistory['snapshot']>;
  frameIntervalWindow: 'last-180-visible-raf-intervals';
  highestAssetUrls: string[];
  highestAssetPayloadBytes: number;
  highestAssetPayloadSource: 'manifest-byteLength';
  viewport: TrialViewport;
}
export interface BenchmarkReport {
  schema: 'stream3d-benchmark/1';
  scene: { index: number; title: string; objects: number; uniqueAssets: number };
  profile: { id: NetworkProfileId; bytesPerSecond: number | null; latencyMs: number };
  conditions: { width: number; height: number; pixelRatio: number; devicePixelRatio: number; budgetBytes: number; animations: 'stopped'; engine: 'already loaded'; order: LoadingMode[] };
  trials: TrialResult[];
  notes: string[];
}
export interface TrialProgress {
  mode: LoadingMode;
  phase: 'loading' | 'refining' | 'complete';
  elapsedMs: number;
  ready: number;
  total: number;
  bytesReceived: number;
}

export async function runComparison(options: {
  createCanvas(): HTMLCanvasElement;
  story: Story;
  profile: NetworkProfileId;
  signal: AbortSignal;
  onProgress(progress: TrialProgress): void;
  onResult(result: TrialResult): void;
}): Promise<BenchmarkReport> {
  options.signal.throwIfAborted();
  assertVisible();
  // Vary trial order; both trials receive new apps, new session URLs, and no-store HTTP bodies.
  const order: LoadingMode[] = Math.random() < 0.5 ? ['progressive', 'whole'] : ['whole', 'progressive'];
  const report: BenchmarkReport = {
    schema: 'stream3d-benchmark/1',
    scene: { index: options.story.index, title: options.story.title, objects: options.story.actors.length, uniqueAssets: new Set(options.story.actors.map(a => a.kit)).size },
    profile: { id: options.profile, bytesPerSecond: NETWORK_PROFILES[options.profile].bytesPerSecond, latencyMs: NETWORK_PROFILES[options.profile].latencyMs },
    conditions: { width: 0, height: 0, pixelRatio: effectivePixelRatio(), devicePixelRatio: devicePixelRatio || 1, budgetBytes: 512 * 1024 ** 2, animations: 'stopped', engine: 'already loaded', order },
    trials: [],
    notes: [
      'First useful = terrain and hero prepared, followed by two animation frames. This is not physical display or GPU timing.',
      'Timers start before app and scene construction. Useful, all-object, and highest-detail endpoints each independently wait two animation frames after their readiness condition.',
      'Both modes target every scene object at the exact same highest compiled GLB; animations are stopped and the camera is fixed.',
      'Fresh apps reset runtime pools; unique session URLs and no-store HTTP responses prevent prior asset responses being reused. Already loaded JavaScript/decoders and GPU driver caches may remain warm.',
      'bytesReceived counts Response.body payload, including partial transfers, not HTTP wire bytes. Bandwidth is shared per trial session.',
      'Resident peak is the largest framework estimate sampled on RAF callbacks and completion, not an exact hardware high-water mark. RAF intervals are main-thread scheduling measurements, not a hardware FPS guarantee.',
      'Frame statistics contain at most the last 180 visible-page RAF intervals at trial completion; they are a trailing window, not the full trial distribution.',
      'Progressive loading may transfer more total bytes because it also downloads intermediate levels.',
      'highestAssetPayloadBytes comes from compiled manifest byteLength values and verifies equivalent target assets; actual received bytes are reported separately in network.',
      'This is one sequential pair with randomized order, not a statistical performance distribution. Viewport size, device pixel ratio and page visibility must remain unchanged.',
    ],
  };
  let expectedViewport: TrialViewport | null = null;
  for (const mode of order) {
    options.signal.throwIfAborted();
    assertVisible();
    const canvas = options.createCanvas();
    const viewport = readViewport(canvas);
    if (expectedViewport) assertSameViewport(viewport, expectedViewport);
    else {
      expectedViewport = viewport;
      Object.assign(report.conditions, viewport);
    }
    const result = await runTrial({ ...options, canvas, mode, viewport });
    report.trials.push(result);
    options.onResult(result);
  }
  return report;
}

async function runTrial(options: {
  canvas: HTMLCanvasElement;
  story: Story;
  profile: NetworkProfileId;
  mode: LoadingMode;
  viewport: TrialViewport;
  signal: AbortSignal;
  onProgress(progress: TrialProgress): void;
}): Promise<TrialResult> {
  const started = performance.now();
  const app = makeApp(options.canvas, 512);
  const lifetime = new AbortController();
  let frame = 0;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let observer: ResizeObserver | undefined;
  let rejectInterruption!: (reason: unknown) => void;
  const interrupted = new Promise<never>((_, reject) => { rejectInterruption = reject; });
  // Setup errors can occur before the race is attached. Keep interruption rejection observed.
  void interrupted.catch(() => {});
  const interrupt = (reason: unknown) => {
    if (lifetime.signal.aborted) return;
    lifetime.abort(reason);
    rejectInterruption(reason);
  };
  const onAbort = () => interrupt(options.signal.reason ?? new DOMException('Comparison cancelled', 'AbortError'));
  const checkConditions = () => {
    assertVisible();
    assertSameViewport(readViewport(options.canvas), options.viewport);
  };
  const onEnvironmentChange = () => {
    try { checkConditions(); }
    catch (error) { interrupt(error); }
  };
  try {
    options.signal.throwIfAborted();
    checkConditions();
    options.signal.addEventListener('abort', onAbort, { once: true });
    document.addEventListener('visibilitychange', onEnvironmentChange);
    window.addEventListener('resize', onEnvironmentChange);
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(onEnvironmentChange);
      observer.observe(options.canvas);
    }
    timeout = setTimeout(() => interrupt(new Error('Comparison exceeded 120 seconds. Choose a faster profile or a smaller scene.')), 120_000);

    const session = `trial-${options.mode}-${crypto.randomUUID()}`;
    const assetSet = createAssetSet({ mode: options.mode, profile: options.profile, session, controlled: true, forceHighest: true });
    const bundle = buildScene(app, options.story, assetSet);
    for (const actor of bundle.actors) actor.model.animation.stop();
    updateCamera(bundle, options.viewport.width / options.viewport.height, true);
    const frames = new FrameHistory();
    let peak = 0;
    let firstUsefulMs: number | null = null;
    let bytesAtFirstUseful = 0;
    let allObjectsMs: number | null = null;
    let highestDetailMs: number | null = null;
    let lastUpdate = 0;
    let highestObserved = false;
    let settleHighest!: () => void;
    const highestPrepared = new Promise<void>(resolve => { settleHighest = resolve; });
    app.present(bundle.scene);

    const useful = Promise.all(bundle.essential.map(model => model.ready())).then(async () => {
      await twoAnimationFrames(lifetime.signal);
      firstUsefulMs = performance.now() - started;
      bytesAtFirstUseful = app.diagnostics().network.bytesReceived;
    });
    const allObjects = Promise.all(bundle.actors.map(actor => actor.model.ready())).then(async () => {
      await twoAnimationFrames(lifetime.signal);
      allObjectsMs = performance.now() - started;
    });
    const highestReady = Promise.race([highestPrepared, interrupted]).then(async () => {
      await twoAnimationFrames(lifetime.signal);
      highestDetailMs = performance.now() - started;
    });
    // Each endpoint owns its timestamp. Waiting for another endpoint cannot inflate it.
    const measured = Promise.all([useful, allObjects, highestReady]);

    const sample = (timestamp: number) => {
      try {
        lifetime.signal.throwIfAborted();
        checkConditions();
        frames.sample(timestamp);
        const diagnostics = app.diagnostics();
        peak = Math.max(peak, diagnostics.estimatedGpuBytes);
        const failed = bundle.actors.find(actor => actor.model.error);
        if (failed) { interrupt(failed.model.error); return; }
        const ready = bundle.actors.filter(actor => actor.model.currentLevel !== null).length;
        if (timestamp - lastUpdate > 150) {
          lastUpdate = timestamp;
          options.onProgress({ mode: options.mode, phase: firstUsefulMs === null ? 'loading' : 'refining', elapsedMs: performance.now() - started, ready, total: bundle.actors.length, bytesReceived: diagnostics.network.bytesReceived });
        }
        if (!highestObserved && bundle.actors.every(actor => {
          const model = actor.model;
          return model.manifest && model.currentLevel === model.manifest.levels.length - 1 && model.pendingLevel === null;
        })) {
          highestObserved = true;
          settleHighest();
        }
        // Keep the trailing frame window current through all endpoint RAF waits.
        frame = requestAnimationFrame(sample);
      } catch (error) { interrupt(error); }
    };
    frame = requestAnimationFrame(sample);
    await Promise.race([measured, interrupted]);
    options.signal.throwIfAborted();
    lifetime.signal.throwIfAborted();
    checkConditions();
    const snapshot = app.diagnostics();
    peak = Math.max(peak, snapshot.estimatedGpuBytes);
    const highest = [...new Set(options.story.actors.map(actor => actor.kit))].map(kit => assets[kit].levels.at(-1)!);
    const uniqueHighest = new Map(highest.map(level => [new URL(level.url, document.baseURI).href, level.byteLength]));
    const result: TrialResult = {
      mode: options.mode,
      firstUsefulMs: firstUsefulMs!, allObjectsMs: allObjectsMs!, highestDetailMs: highestDetailMs!,
      bytesAtFirstUseful, network: { ...snapshot.network }, peakResidentBytes: peak,
      frameIntervals: frames.snapshot(), frameIntervalWindow: 'last-180-visible-raf-intervals',
      highestAssetUrls: [...uniqueHighest.keys()].sort(),
      highestAssetPayloadBytes: [...uniqueHighest.values()].reduce((sum, bytes) => sum + bytes, 0),
      highestAssetPayloadSource: 'manifest-byteLength', viewport: { ...options.viewport },
    };
    options.onProgress({ mode: options.mode, phase: 'complete', elapsedMs: result.highestDetailMs, ready: bundle.actors.length, total: bundle.actors.length, bytesReceived: result.network.bytesReceived });
    return result;
  } finally {
    interrupt(new DOMException('Trial finished', 'AbortError'));
    cancelAnimationFrame(frame);
    if (timeout !== undefined) clearTimeout(timeout);
    observer?.disconnect();
    options.signal.removeEventListener('abort', onAbort);
    document.removeEventListener('visibilitychange', onEnvironmentChange);
    window.removeEventListener('resize', onEnvironmentChange);
    app.destroy();
  }
}

function effectivePixelRatio(): number {
  return Math.max(0.5, Math.min(devicePixelRatio || 1, 1.25));
}

function readViewport(canvas: HTMLCanvasElement): TrialViewport {
  const { clientWidth: width, clientHeight: height } = canvas;
  if (width <= 0 || height <= 0) throw new Error('Comparison canvas must have a non-zero CSS size.');
  return { width, height, pixelRatio: effectivePixelRatio(), devicePixelRatio: devicePixelRatio || 1 };
}

function assertSameViewport(actual: TrialViewport, expected: TrialViewport): void {
  if (actual.width !== expected.width || actual.height !== expected.height
    || actual.devicePixelRatio !== expected.devicePixelRatio || actual.pixelRatio !== expected.pixelRatio) {
    throw new Error('Comparison stopped because the canvas size or device pixel ratio changed. Keep the viewport unchanged for both trials.');
  }
}

function assertVisible(): void {
  if (document.visibilityState !== 'visible') {
    throw new Error('Comparison stopped because the page is hidden. Keep it visible for valid frame timings.');
  }
}

function twoAnimationFrames(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let frame = 0;
    const onAbort = () => {
      cancelAnimationFrame(frame);
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason ?? new DOMException('Comparison cancelled', 'AbortError'));
    };
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener('abort', onAbort, { once: true });
    frame = requestAnimationFrame(() => {
      if (signal.aborted) { onAbort(); return; }
      frame = requestAnimationFrame(() => {
        if (signal.aborted) { onAbort(); return; }
        signal.removeEventListener('abort', onAbort);
        resolve();
      });
    });
  });
}
