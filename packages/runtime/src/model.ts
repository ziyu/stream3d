import {
  AnimationMixer, Box3, Color, Group, LoopOnce, LoopRepeat, Mesh, Sphere, Vector3,
} from 'three';
import type {
  AnimationClip, Euler, Frustum, Intersection, Material, Object3D, PerspectiveCamera,
} from 'three';
import type { AssetInput, AssetManifest } from '@stream3d/core';
import type { StreamApp, ManagedScene } from './app.js';
import type { AnimationOptions, MaterialOverride, ModelTemplate, ModelTiming } from './types.js';
import { abortError, disposeInstance, instanceAnimations, instantiateTemplate, isAbort } from './resources.js';

interface Payload {
  object: Object3D;
  template: ModelTemplate;
  animations: AnimationClip[];
  release(): void;
}

export interface ModelClickEvent {
  model: ManagedModel;
  intersection: Intersection;
  originalEvent: PointerEvent;
}

export interface ModelErrorEvent {
  model: ManagedModel;
  error: Error;
  level: string | null;
}

type ModelEvents = { click: ModelClickEvent; error: ModelErrorEvent };

export class ManagedModel {
  /** Stable root. Children are renderer-owned and may change as quality changes. */
  readonly object3D = new Group();
  readonly id = this.object3D.uuid;
  readonly animation: {
    play: (name: string, options?: AnimationOptions) => void;
    stop: () => void;
    readonly time: number;
    readonly current: string | null;
  };
  readonly materials: { set: (name: string, override: MaterialOverride) => void };
  manifest: AssetManifest | null = null;
  currentLevel: number | null = null;
  pendingLevel: number | null = null;
  coverage = 0;
  visible = false;
  error: Error | null = null;
  destroyed = false;

  private readonly lifetime = new AbortController();
  private pending: AbortController | null = null;
  private payload: Payload | null = null;
  private mixer: AnimationMixer | null = null;
  private generation = 0;
  private active = false;
  private visibleSince = 0;
  private lastVisibleAt = 0;
  private targetLevel = 0;
  private readonly failedLevels = new Set<number>();
  private readonly overrides = new Map<string, MaterialOverride>();
  private readonly listeners = new Map<keyof ModelEvents, Set<(event: never) => void>>();
  private readonly waiters = new Set<{ resolve: () => void; reject: (reason: unknown) => void }>();
  private animationState: { name: string; time: number; loop: boolean; timeScale: number } | null = null;
  private readonly localBounds = new Box3();
  private readonly worldBounds = new Box3();
  private readonly sphere = new Sphere();
  private readonly viewPosition = new Vector3();
  private readonly measuredTiming: ModelTiming = { firstReadyMs: null, lastReadyMs: null };

  constructor(readonly scene: ManagedScene, private readonly input: AssetInput) {
    const self = this;
    this.animation = {
      play(name, options = {}) {
        if (self.destroyed) throw new Error('Cannot animate a destroyed model');
        if (self.manifest && !self.manifest.animations.includes(name)) {
          throw new Error(`Unknown animation ${JSON.stringify(name)}`);
        }
        self.animationState = {
          name, time: 0, loop: options.loop ?? true, timeScale: options.timeScale ?? 1,
        };
        self.bindAnimation();
      },
      stop() {
        self.animationState = null;
        self.mixer?.stopAllAction();
      },
      get time() { return self.animationState?.time ?? 0; },
      get current() { return self.animationState?.name ?? null; },
    };
    this.materials = {
      set: (name, override) => {
        if (this.destroyed) throw new Error('Cannot edit a destroyed model');
        this.overrides.set(name, { ...this.overrides.get(name), ...override });
        if (this.payload) this.applyOverrides(this.payload.object);
      },
    };
    this.object3D.name = 'ManagedModel';
    scene.root.add(this.object3D);
    void this.initialize();
  }

  get position(): Vector3 { return this.object3D.position; }
  get rotation(): Euler { return this.object3D.rotation; }
  get scale(): Vector3 { return this.object3D.scale; }
  get app(): StreamApp { return this.scene.app; }
  /** Timings stop at prepared attachment; they do not claim a frame has been displayed. */
  get timing(): ModelTiming { return { ...this.measuredTiming }; }

  private async initialize(): Promise<void> {
    try {
      const manifest = await this.app.resources.resolve(this.input, this.lifetime.signal);
      if (this.destroyed) return;
      this.manifest = manifest;
      this.object3D.name = manifest.name;
      this.localBounds.min.fromArray(manifest.bounds.min);
      this.localBounds.max.fromArray(manifest.bounds.max);
      this.error = null;
      this.app.invalidate();
    } catch (reason) {
      if (!this.destroyed && !isAbort(reason)) this.reportError(reason, null);
    }
  }

  ready(stage: 'interactive' = 'interactive'): Promise<void> {
    if (stage !== 'interactive') return Promise.reject(new Error(`Unknown readiness stage: ${stage}`));
    if (this.destroyed) return Promise.reject(abortError('Model was destroyed'));
    if (this.payload) return Promise.resolve();
    if (this.error && (this.failedLevels.has(0) || !this.manifest)) return Promise.reject(this.error);
    return new Promise((resolve, reject) => this.waiters.add({ resolve, reject }));
  }

  on<K extends keyof ModelEvents>(type: K, handler: (event: ModelEvents[K]) => void): () => void {
    let listeners = this.listeners.get(type);
    if (!listeners) this.listeners.set(type, listeners = new Set());
    listeners.add(handler as (event: never) => void);
    return () => listeners.delete(handler as (event: never) => void);
  }

  /** Retry failed network/parse jobs without replacing the logical model. */
  retry(): void {
    if (this.destroyed) return;
    this.failedLevels.clear();
    this.error = null;
    if (!this.manifest) void this.initialize();
    this.app.invalidate();
  }

  /** @internal */
  measure(camera: PerspectiveCamera, frustum: Frustum): { visible: boolean; coverage: number } {
    if (!this.manifest || this.destroyed || !this.object3D.visible) return { visible: false, coverage: 0 };
    this.worldBounds.copy(this.localBounds).applyMatrix4(this.object3D.matrixWorld);
    this.worldBounds.getBoundingSphere(this.sphere);
    if (!frustum.intersectsSphere(this.sphere)) {
      // An authored rest-pose box cannot safely cull an arbitrary animation. Keep the coarse
      // representation until a future manifest version supplies a verified animation envelope.
      return { visible: this.manifest.animations.length > 0, coverage: 0 };
    }
    this.viewPosition.copy(this.sphere.center).applyMatrix4(camera.matrixWorldInverse);
    const distance = Math.max(camera.near, -this.viewPosition.z);
    const height = 2 * distance * Math.tan(camera.fov * Math.PI / 360) / camera.zoom;
    return { visible: true, coverage: Math.min(1, (2 * this.sphere.radius) / Math.max(height, 0.001)) };
  }

  /** @internal */
  setDemand(active: boolean, visible: boolean, coverage: number, target: number, now: number): void {
    if (this.destroyed) return;
    if (!active) {
      const wasActive = this.active;
      this.active = false;
      this.visible = false;
      this.coverage = 0;
      this.releasePayload();
      if (wasActive) this.rejectWaiters(abortError('Scene is no longer active'));
      return;
    }
    this.active = true;
    if (visible && !this.visible) this.visibleSince = now;
    this.visible = visible;
    this.coverage = coverage;
    if (visible) this.lastVisibleAt = now;
    if (!visible) {
      this.cancelPending();
      if (now - this.lastVisibleAt >= this.app.offscreenGraceMs) this.releasePayload();
      return;
    }
    this.targetLevel = now - this.visibleSince >= this.app.refinementDelayMs ? target : 0;
    this.reconcile();
  }

  private reconcile(): void {
    if (!this.active || !this.visible || !this.manifest || this.destroyed) return;
    const current = this.currentLevel;
    const next = current === null ? 0
      : current > this.targetLevel ? this.targetLevel
      : Math.min(current + 1, this.targetLevel);
    if (next === current || this.failedLevels.has(next)) {
      this.cancelPending();
      return;
    }
    if (this.pendingLevel === next) return;
    this.cancelPending();
    void this.loadLevel(next);
  }

  private async loadLevel(index: number): Promise<void> {
    const manifest = this.manifest;
    const level = manifest?.levels[index];
    if (!manifest || !level) return;
    const firstRepresentation = this.currentLevel === null;
    const startedAt = performance.now();
    const controller = new AbortController();
    this.pending = controller;
    this.pendingLevel = index;
    const generation = ++this.generation;
    // A resolved template stays leased while GPU preparation is still using it. Pending
    // requests can be canceled immediately; non-preemptible preparation releases in finally.
    const lease = this.app.resources.acquire(manifest, level);
    let hasTemplate = false;
    const cancelLease = () => { if (!hasTemplate) lease.release(); };
    controller.signal.addEventListener('abort', cancelLease, { once: true });
    let instance: Object3D | null = null;
    let installed = false;
    try {
      const template = await lease.value;
      hasTemplate = true;
      if (!this.isCurrent(generation, controller)) return;
      if (this.payload?.template === template) {
        this.currentLevel = index;
        this.error = null;
        return;
      }
      instance = instantiateTemplate(template);
      this.applyOverrides(instance);
      await this.app.prepare(instance, this.scene, controller.signal);
      if (!this.isCurrent(generation, controller)) return;
      this.applyOverrides(instance); // User edits may have arrived while preparation was pending.

      // Attach the replacement before releasing the old representation. The logical root is stable.
      const previous = this.payload;
      this.clearMixer();
      this.object3D.add(instance);
      this.payload = {
        object: instance, template, animations: instanceAnimations(template, instance),
        release: () => lease.release(),
      };
      this.currentLevel = index;
      this.bindAnimation();
      installed = true;
      if (firstRepresentation) {
        const elapsed = Math.max(0, performance.now() - startedAt);
        this.measuredTiming.lastReadyMs = elapsed;
        this.measuredTiming.firstReadyMs ??= elapsed;
      }
      if (previous) {
        disposeInstance(previous.object);
        previous.release();
      }
      this.error = null;
      for (const waiter of this.waiters) waiter.resolve();
      this.waiters.clear();
    } catch (reason) {
      if (this.isCurrent(generation, controller) && !isAbort(reason)) {
        this.failedLevels.add(index);
        this.reportError(reason, level.id);
      }
    } finally {
      controller.signal.removeEventListener('abort', cancelLease);
      if (!installed) {
        if (instance) disposeInstance(instance);
        lease.release();
      }
      if (this.pending === controller) {
        this.pending = null;
        this.pendingLevel = null;
      }
    }
  }

  private isCurrent(generation: number, controller: AbortController): boolean {
    return !this.destroyed && this.active && this.visible && !controller.signal.aborted
      && this.generation === generation;
  }

  private applyOverrides(root: Object3D): void {
    root.traverse(object => {
      const material = (object as Mesh).material;
      if (!material) return;
      for (const item of Array.isArray(material) ? material : [material]) {
        const override = { ...this.overrides.get('*'), ...this.overrides.get(item.name) };
        applyMaterialOverride(item, override);
      }
    });
  }

  private bindAnimation(): void {
    this.clearMixer();
    if (!this.payload || !this.animationState) return;
    const clip: AnimationClip | undefined = this.payload.animations.find(
      candidate => candidate.name === this.animationState?.name,
    );
    if (!clip) return;
    this.mixer = new AnimationMixer(this.payload.object);
    const action = this.mixer.clipAction(clip);
    action.setLoop(this.animationState.loop ? LoopRepeat : LoopOnce, this.animationState.loop ? Infinity : 1);
    action.clampWhenFinished = !this.animationState.loop;
    action.play();
    this.mixer.setTime(this.animationState.time);
  }

  /** @internal Animation state progresses while its scene is active, including offscreen. */
  advance(delta: number): void {
    if (!this.active || !this.animationState) return;
    const step = delta * this.animationState.timeScale;
    this.animationState.time += step;
    this.mixer?.update(step);
  }

  private clearMixer(): void {
    if (this.mixer) {
      this.mixer.stopAllAction();
      if (this.payload) this.mixer.uncacheRoot(this.payload.object);
      this.mixer = null;
    }
  }

  private cancelPending(): void {
    if (this.pending) {
      this.generation++;
      this.pending.abort(abortError('Representation is no longer needed'));
      this.pending = null;
      this.pendingLevel = null;
    }
  }

  private releasePayload(): void {
    this.cancelPending();
    if (this.payload) {
      this.clearMixer();
      disposeInstance(this.payload.object);
      this.payload.release();
      this.payload = null;
      this.currentLevel = null;
    }
  }

  private reportError(reason: unknown, level: string | null): void {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    this.error = error;
    if (!this.payload) this.rejectWaiters(error);
    this.emit('error', { model: this, error, level });
  }

  private rejectWaiters(reason: unknown): void {
    for (const waiter of this.waiters) waiter.reject(reason);
    this.waiters.clear();
  }

  private emit<K extends keyof ModelEvents>(type: K, event: ModelEvents[K]): void {
    for (const listener of this.listeners.get(type) ?? []) {
      try { listener(event as never); }
      catch (error) { queueMicrotask(() => { console.error('stream3d event handler failed', error); }); }
    }
  }

  /** @internal */
  click(intersection: Intersection, originalEvent: PointerEvent): void {
    this.emit('click', { model: this, intersection, originalEvent });
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.lifetime.abort(abortError('Model was destroyed'));
    this.releasePayload();
    this.rejectWaiters(abortError('Model was destroyed'));
    this.listeners.clear();
    this.object3D.removeFromParent();
    this.scene.models.delete(this);
  }
}

function applyMaterialOverride(material: Material, override: MaterialOverride): void {
  const target = material as unknown as Record<string, unknown>;
  let programChanged = false;
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined || !materialOverrideKeys.has(key) || !(key in target)) continue;
    if ((key === 'color' || key === 'emissive') && target[key] instanceof Color) {
      (target[key] as Color).set(value as Parameters<Color['set']>[0]);
    } else {
      if (key === 'transparent' && target[key] !== value) programChanged = true;
      target[key] = value;
    }
  }
  // Color, roughness, opacity, etc. are uniform/state updates. Invalidating their shader
  // after compileAsync would needlessly undo preparation for every representation swap.
  if (programChanged) material.needsUpdate = true;
}

const materialOverrideKeys = new Set([
  'color', 'emissive', 'emissiveIntensity', 'roughness', 'metalness',
  'opacity', 'transparent', 'wireframe', 'visible',
]);
