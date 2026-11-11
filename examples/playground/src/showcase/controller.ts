import { ACESFilmicToneMapping, WebGLRenderer } from 'three';
import { createApp, type StreamApp } from 'stream3d';
import { stories } from './catalog.js';
import { afterPaint, buildScene, createAssetSet, updateCamera, type Actor, type AssetPolicy, type SceneBundle } from './scenes.js';

export interface Visit {
  index: number;
  startedAt: number;
  firstUsefulMs: number | null;
  allObjectsMs: number | null;
  error: string | null;
}

export class FrameHistory {
  private times: number[] = [];
  private previous: number | null = null;
  sample(timestamp: number): void {
    if (document.visibilityState !== 'visible') { this.previous = null; return; }
    if (this.previous !== null) {
      this.times.push(timestamp - this.previous);
      if (this.times.length > 180) this.times.shift();
    }
    this.previous = timestamp;
  }
  reset(): void { this.times = []; this.previous = null; }
  snapshot() {
    const ordered = [...this.times].sort((a, b) => a - b);
    const p95 = ordered.length ? ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * 0.95) - 1)]! : 0;
    const mean = this.times.length ? this.times.reduce((a, b) => a + b, 0) / this.times.length : 0;
    return { samples: ordered.length, p95Ms: p95, meanMs: mean, fps: mean ? 1000 / mean : 0 };
  }
}

export function makeApp(canvas: HTMLCanvasElement, budgetMiB: number): StreamApp {
  const app = createApp({
    canvas, maxPixelRatio: 1.25, refinementDelayMs: 450,
    budgets: { gpuBytes: budgetMiB * 1024 ** 2, cacheBytes: 64 * 1024 ** 2, decodeConcurrency: 2 },
  });
  if (app.renderer instanceof WebGLRenderer) {
    app.renderer.toneMapping = ACESFilmicToneMapping;
    app.renderer.toneMappingExposure = 1.1;
  }
  return app;
}

export class FeedController {
  readonly app: StreamApp;
  readonly bundles = new Map<number, SceneBundle>();
  readonly frames = new FrameHistory();
  readonly history: { at: number; resident: number; received: number; frameP95: number }[] = [];
  readonly events: { at: number; text: string }[] = [];
  readonly visits = new Map<number, number>();
  activeIndex = -1;
  visit: Visit | null = null;
  selected: Actor | null = null;
  peakResidentBytes = 0;
  private readonly assetSet;
  private generation = 0;
  private disposed = false;
  private readonly cameraState = new Map<number, { yaw: number; close: boolean }>();

  constructor(readonly canvas: HTMLCanvasElement, readonly policy: AssetPolicy, budgetMiB = 96) {
    this.app = makeApp(canvas, budgetMiB);
    this.assetSet = createAssetSet(policy);
  }

  get active(): SceneBundle | undefined { return this.bundles.get(this.activeIndex); }

  show(index: number): void {
    if (this.disposed) return;
    const startedAt = performance.now();
    const next = Math.max(0, Math.min(stories.length - 1, Math.round(index)));
    if (next === this.activeIndex) return;
    if (this.active) this.cameraState.set(this.activeIndex, { yaw: this.active.yaw, close: this.active.close });
    const bundle = this.ensure(next);
    this.activeIndex = next;
    this.selected = bundle.hero;
    const token = ++this.generation;
    const visit: Visit = { index: next, startedAt, firstUsefulMs: null, allObjectsMs: null, error: null };
    this.visit = visit;
    this.visits.set(next, (this.visits.get(next) ?? 0) + 1);
    updateCamera(bundle, this.canvas.clientWidth / Math.max(1, this.canvas.clientHeight), true);
    this.app.present(bundle.scene);
    // Adjacent logical scenes are cheap; inactive scenes do not fetch model representations.
    for (const neighbor of [next - 1, next + 1]) if (neighbor >= 0 && neighbor < stories.length) this.ensure(neighbor);
    for (const [key, old] of this.bundles) {
      if (Math.abs(key - next) > 1) { old.destroy(); this.bundles.delete(key); }
    }
    this.record(`Present ${String(next + 1).padStart(2, '0')} · ${bundle.actors.length} objects`);
    void Promise.all(bundle.essential.map(model => model.ready())).then(async () => {
      await afterPaint();
      if (token === this.generation && !this.disposed) visit.firstUsefulMs = performance.now() - visit.startedAt;
    }).catch(error => this.handleReadinessError(error, token, visit));
    void Promise.all(bundle.actors.map(actor => actor.model.ready())).then(async () => {
      await afterPaint();
      if (token === this.generation && !this.disposed) visit.allObjectsMs = performance.now() - visit.startedAt;
    }).catch(error => this.handleReadinessError(error, token, visit));
  }

  private handleReadinessError(error: unknown, token: number, visit: Visit): void {
    if (token !== this.generation || this.disposed || (error instanceof Error && error.name === 'AbortError')) return;
    visit.error = error instanceof Error ? error.message : String(error);
    this.record(visit.error);
  }

  private ensure(index: number): SceneBundle {
    const cached = this.bundles.get(index);
    if (cached) return cached;
    const bundle = buildScene(this.app, stories[index]!, this.assetSet, actor => { this.selected = actor; });
    const state = this.cameraState.get(index);
    if (state) { bundle.yaw = state.yaw; bundle.close = state.close; }
    this.bundles.set(index, bundle);
    return bundle;
  }

  tick(timestamp: number): void {
    if (this.disposed) return;
    this.frames.sample(timestamp);
    if (this.active) updateCamera(this.active, this.canvas.clientWidth / Math.max(1, this.canvas.clientHeight));
  }

  sample(): ReturnType<FeedController['snapshot']> {
    const snapshot = this.snapshot();
    this.peakResidentBytes = Math.max(this.peakResidentBytes, snapshot.runtime.estimatedGpuBytes);
    this.history.push({ at: performance.now(), resident: snapshot.runtime.estimatedGpuBytes, received: snapshot.runtime.network.bytesReceived, frameP95: snapshot.frames.p95Ms });
    if (this.history.length > 120) this.history.shift();
    return { ...snapshot, peakResidentBytes: this.peakResidentBytes };
  }

  snapshot() {
    const bundle = this.active;
    const quality = { preview: 0, standard: 0, full: 0, waiting: 0 };
    for (const actor of bundle?.actors ?? []) {
      const model = actor.model;
      const name = model.currentLevel === null ? 'waiting' : model.manifest?.levels[model.currentLevel]?.id;
      if (name && name in quality) quality[name as keyof typeof quality]++;
    }
    return {
      activeIndex: this.activeIndex, totalCards: stories.length, retainedScenes: this.bundles.size,
      objectCount: bundle?.actors.length ?? 0, readyObjects: (bundle?.actors ?? []).filter(a => a.model.currentLevel !== null).length,
      uniqueAssets: new Set(bundle?.actors.map(a => a.kit)).size,
      visit: this.visit ? { ...this.visit } : null, visits: this.visits.get(this.activeIndex) ?? 0,
      quality, peakResidentBytes: this.peakResidentBytes, frames: this.frames.snapshot(), runtime: this.app.diagnostics(),
    };
  }

  clearCache(): ReturnType<StreamApp['clearCache']> {
    const result = this.app.clearCache();
    this.record(`Cleared ${result.representations.entries + result.bytes.entries + result.manifests.entries} idle cache entries`);
    return result;
  }

  record(message: string): void {
    this.events.unshift({ at: performance.now(), text: message });
    if (this.events.length > 8) this.events.pop();
  }

  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    ++this.generation;
    this.app.destroy();
    this.bundles.clear();
  }
}
