import {
  Color, Frustum, Matrix4, PerspectiveCamera, Raycaster, Scene, Vector2, Vector3,
  WebGLRenderer,
} from 'three';
import type { Object3D, Texture } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { AssetInput } from '@stream3d/core';
import { ManagedModel } from './model.js';
import { abortError, assertLive, AssetResources, collectTextures } from './resources.js';
import type { AppOptions, RendererBackend, RuntimeBudgets } from './types.js';

const MiB = 1024 * 1024;

export class ManagedScene {
  /** Escape hatch for lights/environment/custom Three objects. Added raw resources are caller-owned. */
  readonly root = new Scene();
  readonly camera = new PerspectiveCamera(45, 1, 0.05, 2_000);
  /** @internal */
  readonly models = new Set<ManagedModel>();
  /** @internal */
  readonly controlsTarget = new Vector3();
  destroyed = false;

  constructor(readonly app: StreamApp) {
    this.camera.position.set(0, 0, 4);
    this.root.background = new Color('#10141d');
  }

  addModel(input: AssetInput): ManagedModel {
    if (this.destroyed) throw new Error('Cannot add a model to a destroyed scene');
    const model = new ManagedModel(this, input);
    this.models.add(model);
    return model;
  }

  remove(model: ManagedModel): void {
    if (model.scene !== this) throw new Error('Model belongs to a different scene');
    model.destroy();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const model of [...this.models]) model.destroy();
    this.root.clear();
    this.app.removeScene(this);
  }
}

interface UploadJob {
  texture: Texture;
  signal: AbortSignal;
  resolve(): void;
  reject(reason: unknown): void;
  onAbort(): void;
}

export class StreamApp {
  /** @internal */
  readonly resources: AssetResources;
  readonly renderer: RendererBackend;
  readonly refinementDelayMs: number;
  readonly offscreenGraceMs: number;
  controls: OrbitControls | undefined;
  private readonly canvas: HTMLCanvasElement;
  private readonly scenes = new Set<ManagedScene>();
  private activeScene: ManagedScene | null = null;
  private readonly budgets: RuntimeBudgets;
  private readonly now: () => number;
  private readonly autoStart: boolean;
  private readonly controlsEnabled: boolean;
  private readonly maxPixelRatio: number;
  private readonly frustum = new Frustum();
  private readonly projection = new Matrix4();
  private readonly raycaster = new Raycaster();
  private readonly pointer = new Vector2();
  private readonly uploads: UploadJob[] = [];
  private initializedTextures = new WeakSet<Texture>();
  private readonly removeListeners: (() => void)[] = [];
  private resizeObserver: ResizeObserver | null = null;
  private raf: number | null = null;
  private lastFrame: number | null = null;
  private lastSweep = 0;
  private width = 0;
  private height = 0;
  private pixelRatio = 0;
  private contextLost = false;
  private disposed = false;
  private minimumVisibleBytes = 0;
  private pointerStart: { id: number; x: number; y: number } | null = null;

  constructor(options: AppOptions) {
    this.canvas = options.canvas;
    this.now = options.now ?? (() => performance.now());
    this.autoStart = options.autoStart ?? true;
    this.controlsEnabled = options.controls ?? false;
    this.refinementDelayMs = options.refinementDelayMs ?? 350;
    this.offscreenGraceMs = options.offscreenGraceMs ?? 750;
    this.maxPixelRatio = options.maxPixelRatio ?? 1.5;
    this.budgets = {
      gpuBytes: options.budgets?.gpuBytes ?? 96 * MiB,
      cacheBytes: options.budgets?.cacheBytes ?? 64 * MiB,
      decodeConcurrency: options.budgets?.decodeConcurrency ?? 2,
    };
    for (const [name, value] of Object.entries(this.budgets)) validateBudget(name, value);
    if (!Number.isInteger(this.budgets.decodeConcurrency)) throw new Error('decodeConcurrency must be an integer');
    this.renderer = options.renderer ?? new WebGLRenderer({
      canvas: this.canvas, antialias: true, alpha: false, powerPreference: 'high-performance',
    });
    this.resources = new AssetResources({
      budgets: this.budgets,
      baseUrl: options.baseUrl ?? (typeof document !== 'undefined' ? document.baseURI : 'http://localhost/'),
      loader: options.loader,
      meshoptWorkers: options.meshoptWorkers ?? 2,
      now: this.now,
    });
    this.listen('pointerdown', event => {
      const pointer = event as PointerEvent;
      if (pointer.button !== 0) return;
      this.pointerStart = { id: pointer.pointerId, x: pointer.clientX, y: pointer.clientY };
    });
    this.listen('pointerup', event => this.handlePointerUp(event as PointerEvent));
    this.listen('pointercancel', () => { this.pointerStart = null; });
    this.listen('webglcontextlost', event => {
      event.preventDefault();
      this.contextLost = true;
    });
    this.listen('webglcontextrestored', () => {
      this.contextLost = false;
      this.initializedTextures = new WeakSet();
    });
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(this.canvas);
    }
    this.resize();
    this.invalidate();
  }

  createScene(): ManagedScene {
    if (this.disposed) throw new Error('App was destroyed');
    const scene = new ManagedScene(this);
    this.scenes.add(scene);
    return scene;
  }

  present(scene: ManagedScene): void {
    if (this.disposed) throw new Error('App was destroyed');
    if (scene.app !== this || scene.destroyed) throw new Error('Cannot present this scene');
    if (this.activeScene === scene) return;
    if (this.activeScene) {
      if (this.controls) this.activeScene.controlsTarget.copy(this.controls.target);
      for (const model of this.activeScene.models) model.setDemand(false, false, 0, 0, this.now());
    }
    this.controls?.dispose();
    this.controls = undefined;
    this.activeScene = scene;
    this.resize();
    if (this.controlsEnabled) {
      this.controls = new OrbitControls(scene.camera, this.canvas);
      this.controls.enableDamping = true;
      this.controls.target.copy(scene.controlsTarget);
      this.controls.update();
    }
    // Demand is updated immediately; activation never waits for the entire asset.
    this.tick(0);
  }

  /** Change memory policy; existing visible objects automatically select cheaper representations. */
  setBudgets(budgets: Partial<Pick<RuntimeBudgets, 'gpuBytes' | 'cacheBytes'>>): void {
    if (this.disposed) throw new Error('App was destroyed');
    if (budgets.gpuBytes !== undefined) {
      validateBudget('gpuBytes', budgets.gpuBytes);
      this.budgets.gpuBytes = budgets.gpuBytes;
      this.resources.representations.setBudget(budgets.gpuBytes);
    }
    if (budgets.cacheBytes !== undefined) {
      validateBudget('cacheBytes', budgets.cacheBytes);
      this.budgets.cacheBytes = budgets.cacheBytes;
      this.resources.bytes.setBudget(budgets.cacheBytes);
    }
    this.tick(0);
  }

  /** Optional manual driver for tests/host engines. autoStart:false disables the owned RAF loop. */
  tick(deltaSeconds = 0): void {
    if (this.disposed) return;
    this.resize();
    const now = this.now();
    if (now - this.lastSweep >= 1_000) {
      this.resources.sweep();
      this.lastSweep = now;
    }
    const scene = this.activeScene;
    if (scene) {
      this.controls?.update();
      for (const model of scene.models) model.advance(Math.max(0, Math.min(deltaSeconds, 0.1)));
      scene.root.updateMatrixWorld(true);
      scene.camera.updateMatrixWorld(true);
      this.projection.multiplyMatrices(scene.camera.projectionMatrix, scene.camera.matrixWorldInverse);
      this.frustum.setFromProjectionMatrix(this.projection);
      this.plan(scene, now);
    }
    if (!this.contextLost) {
      this.flushUploads();
      if (scene) this.renderer.render(scene.root, scene.camera);
    }
  }

  private plan(scene: ManagedScene, now: number): void {
    const candidates = [...scene.models].map(model => {
      const measurement = model.measure(scene.camera, this.frustum);
      let cap = 0;
      for (let i = 1; i < (model.manifest?.levels.length ?? 0); i++) {
        const threshold = model.manifest!.levels[i]!.minScreenCoverage;
        const hysteresis = (model.currentLevel ?? 0) >= i ? 0.85 : 1;
        if (measurement.coverage >= threshold * hysteresis) cap = i;
      }
      return { model, ...measurement, cap, desired: 0 };
    });
    const visible = candidates.filter(candidate => candidate.visible && candidate.model.manifest);
    const estimate = () => {
      const unique = new Map<string, number>();
      for (const candidate of visible) {
        const manifest = candidate.model.manifest!;
        const level = manifest.levels[candidate.desired]!;
        const key = this.resources.key(manifest, level);
        unique.set(key, Math.max(unique.get(key) ?? 0, level.estimatedGpuBytes));
      }
      return [...unique.values()].reduce((sum, bytes) => sum + bytes, 0);
    };
    this.minimumVisibleBytes = estimate();
    visible.sort((a, b) => b.coverage - a.coverage);
    // Keep replacement headroom. Mandatory coarse representations may exceed this soft budget.
    const targetBytes = this.budgets.gpuBytes * 0.8;
    const maximumTier = Math.max(0, ...visible.map(candidate => candidate.cap));
    for (let tier = 1; tier <= maximumTier; tier++) {
      for (const candidate of visible) {
        if (candidate.cap < tier || candidate.desired !== tier - 1) continue;
        candidate.desired = tier;
        if (estimate() > targetBytes) candidate.desired = tier - 1;
      }
    }
    for (const candidate of candidates) {
      candidate.model.setDemand(true, candidate.visible, candidate.coverage, candidate.desired, now);
    }
  }

  /** @internal */
  async prepare(object: Object3D, scene: ManagedScene, signal: AbortSignal): Promise<void> {
    assertLive(signal);
    if (this.disposed) throw abortError('App was destroyed');
    if (this.renderer.compileAsync) await this.renderer.compileAsync(object, scene.camera, scene.root);
    assertLive(signal);
    if (!this.renderer.initTexture) return;
    const uploads = [...collectTextures(object)].filter(texture => !this.initializedTextures.has(texture));
    await Promise.all(uploads.map(texture => this.queueUpload(texture, signal)));
    assertLive(signal);
  }

  private queueUpload(texture: Texture, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const job: UploadJob = {
        texture, signal, resolve, reject,
        onAbort: () => {
          const index = this.uploads.indexOf(job);
          if (index !== -1) this.uploads.splice(index, 1);
          reject(signal.reason ?? abortError());
        },
      };
      if (signal.aborted) { reject(signal.reason ?? abortError()); return; }
      signal.addEventListener('abort', job.onAbort, { once: true });
      this.uploads.push(job);
    });
  }

  private flushUploads(): void {
    // Individual uploads are not preemptible. Bound count and retain frame time between assets.
    const start = performance.now();
    for (let count = 0; count < 2 && this.uploads.length; count++) {
      if (count > 0 && performance.now() - start >= 2) break;
      const job = this.uploads.shift()!;
      job.signal.removeEventListener('abort', job.onAbort);
      if (job.signal.aborted) { job.reject(job.signal.reason ?? abortError()); continue; }
      try {
        if (!this.initializedTextures.has(job.texture)) {
          this.renderer.initTexture?.(job.texture);
          this.initializedTextures.add(job.texture);
        }
        job.resolve();
      } catch (error) { job.reject(error); }
    }
  }

  diagnostics() {
    const models = [...this.scenes].flatMap(scene => [...scene.models]);
    const resources = this.resources.representations.stats;
    const info = this.renderer.info;
    return {
      scenes: this.scenes.size,
      models: models.length,
      activeModels: models.filter(model => model.visible).length,
      resources,
      bytes: this.resources.bytes.stats,
      scheduler: { network: this.resources.network.stats, decode: this.resources.decode.stats },
      estimatedGpuBytes: resources.bytes,
      budgetGpuBytes: this.budgets.gpuBytes,
      gpuPressure: resources.bytes > this.budgets.gpuBytes || this.minimumVisibleBytes > this.budgets.gpuBytes,
      pendingUploads: this.uploads.length,
      render: {
        calls: info?.render.calls ?? 0,
        triangles: info?.render.triangles ?? 0,
        geometries: info?.memory.geometries ?? 0,
        textures: info?.memory.textures ?? 0,
      },
      levels: models.map(model => ({
        id: model.id,
        name: model.manifest?.name ?? 'Loading manifest',
        level: model.currentLevel === null ? null : model.manifest?.levels[model.currentLevel]?.id ?? null,
        pending: model.pendingLevel === null ? null : model.manifest?.levels[model.pendingLevel]?.id ?? null,
        visible: model.visible,
        coverage: model.coverage,
        error: model.error?.message ?? null,
      })),
    };
  }

  /** @internal */
  invalidate(): void {
    if (!this.autoStart || this.raf !== null || this.disposed || typeof requestAnimationFrame === 'undefined') return;
    this.raf = requestAnimationFrame(this.frame);
  }

  private readonly frame = (timestamp: number) => {
    this.raf = null;
    const delta = this.lastFrame === null ? 0 : (timestamp - this.lastFrame) / 1_000;
    this.lastFrame = timestamp;
    this.tick(delta);
    this.invalidate();
  };

  private resize(): void {
    if (this.disposed) return;
    const width = Math.max(1, this.canvas.clientWidth || this.canvas.width || 1);
    const height = Math.max(1, this.canvas.clientHeight || this.canvas.height || 1);
    const ratio = Math.max(0.5, Math.min(this.maxPixelRatio, globalThis.devicePixelRatio || 1));
    if (width !== this.width || height !== this.height || ratio !== this.pixelRatio) {
      this.width = width;
      this.height = height;
      this.pixelRatio = ratio;
      this.renderer.setPixelRatio?.(ratio);
      this.renderer.setSize(width, height, false);
    }
    if (this.activeScene && this.activeScene.camera.aspect !== width / height) {
      this.activeScene.camera.aspect = width / height;
      this.activeScene.camera.updateProjectionMatrix();
    }
  }

  private handlePointerUp(event: PointerEvent): void {
    const start = this.pointerStart;
    this.pointerStart = null;
    const scene = this.activeScene;
    if (!start || !scene || start.id !== event.pointerId
      || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 8) return;
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    this.pointer.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointer, scene.camera);
    const visible = [...scene.models].filter(model => model.visible && model.currentLevel !== null);
    const hits = this.raycaster.intersectObjects(visible.map(model => model.object3D), true);
    const hit = hits[0];
    if (!hit) return;
    const roots = new Map(visible.map(model => [model.object3D as Object3D, model]));
    for (let object: Object3D | null = hit.object; object; object = object.parent) {
      const model = roots.get(object);
      if (model) { model.click(hit, event); break; }
    }
  }

  private listen(type: string, handler: EventListener): void {
    this.canvas.addEventListener(type, handler);
    this.removeListeners.push(() => this.canvas.removeEventListener(type, handler));
  }

  /** @internal */
  removeScene(scene: ManagedScene): void {
    this.scenes.delete(scene);
    if (this.activeScene === scene) {
      this.controls?.dispose();
      this.controls = undefined;
      this.activeScene = null;
      this.minimumVisibleBytes = 0;
    }
  }

  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.raf !== null) cancelAnimationFrame(this.raf);
    this.raf = null;
    this.resizeObserver?.disconnect();
    this.controls?.dispose();
    this.controls = undefined;
    for (const remove of this.removeListeners) remove();
    for (const scene of [...this.scenes]) scene.destroy();
    for (const job of this.uploads.splice(0)) {
      job.signal.removeEventListener('abort', job.onAbort);
      job.reject(abortError('App was destroyed'));
    }
    this.resources.dispose();
    this.renderer.dispose();
  }
}

function validateBudget(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive finite number`);
}

export function createApp(options: AppOptions): StreamApp {
  return new StreamApp(options);
}
