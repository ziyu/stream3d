import type {
  AnimationClip, Camera, ColorRepresentation, Group, Object3D, Scene, Texture,
} from 'three';
import type { AssetLevel, AssetManifest } from '@stream3d/core';

export interface RuntimeBudgets {
  /** Soft budget for managed representation memory; estimates, not GPU telemetry. */
  gpuBytes: number;
  /** Downloaded ArrayBuffers retained after their last consumer releases them. */
  cacheBytes: number;
  /** Concurrent parse/transcode jobs. Set at construction. */
  decodeConcurrency: number;
}

/** Lifetime counters for fetches performed by the default runtime transport. */
export interface NetworkDiagnostics {
  /** Actual fetch() calls, excluding tasks canceled before execution and runtime cache hits. */
  requestsStarted: number;
  /** Successful HTTP responses whose entire body was consumed. Parse failures are separate. */
  requestsCompleted: number;
  /** Started requests interrupted by cancellation, including partially consumed bodies. */
  requestsAborted: number;
  /** Started requests ending in HTTP, transport, or response-body errors. */
  requestsFailed: number;
  requestsActive: number;
  /** Bytes delivered by Response.body, including partial failures/aborts; NOT wire bytes. */
  bytesReceived: number;
  /** Response.body bytes belonging to requestsCompleted. */
  bytesCompleted: number;
}

export interface ModelTiming {
  /** First-ever coarse request to prepared attachment, excluding metadata and next paint. */
  firstReadyMs: number | null;
  /** Most recent successful coarse request to prepared attachment, including cache restores. */
  lastReadyMs: number | null;
}

export interface MaterialOverride {
  color?: ColorRepresentation;
  emissive?: ColorRepresentation;
  emissiveIntensity?: number;
  roughness?: number;
  metalness?: number;
  opacity?: number;
  transparent?: boolean;
  wireframe?: boolean;
  visible?: boolean;
}

export interface AnimationOptions {
  loop?: boolean;
  timeScale?: number;
}

/** A loader owns the returned template. The runtime clones it for each instance. */
export interface ModelTemplate {
  scene: Group;
  animations: AnimationClip[];
  /** Optional extra scenes whose resources must be freed with the template. */
  scenes?: Group[];
  estimatedBytes?: number;
}

export interface ModelLoadContext {
  signal: AbortSignal;
  manifest: AssetManifest;
  level: AssetLevel;
}

export type ModelLoader = (context: ModelLoadContext) => Promise<ModelTemplate>;

/** Advanced renderer seam. Raw resources outside managed models remain caller-owned. */
export interface RendererBackend {
  setSize(width: number, height: number, updateStyle?: boolean): void;
  setPixelRatio?(ratio: number): void;
  render(scene: Scene, camera: Camera): void;
  compileAsync?(object: Object3D, camera: Camera, targetScene?: Scene): Promise<unknown>;
  initTexture?(texture: Texture): void;
  dispose(): void;
  info?: {
    memory: { geometries: number; textures: number };
    render: { calls: number; triangles: number };
  };
}

export interface AppOptions {
  canvas: HTMLCanvasElement;
  budgets?: Partial<RuntimeBudgets>;
  controls?: boolean;
  /** Delay after first presentation before requesting better representations. */
  refinementDelayMs?: number;
  /** Keep an offscreen representation briefly to avoid edge-of-frustum thrashing. */
  offscreenGraceMs?: number;
  maxPixelRatio?: number;
  /** Optional Meshopt worker count; 0 disables workers. */
  meshoptWorkers?: number;
  /** Base used for relative URLs in directly supplied manifests. */
  baseUrl?: string;
  /** Useful for integrations and deterministic lifecycle tests. */
  renderer?: RendererBackend;
  loader?: ModelLoader;
  autoStart?: boolean;
  now?: () => number;
}
