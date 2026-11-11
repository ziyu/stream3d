import {
  AnimationClip, BufferGeometry, Material, Mesh, SkinnedMesh, Texture,
} from 'three';
import type { Object3D } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';
import { MeshoptDecoder } from 'meshoptimizer/decoder';
import {
  ResourcePool, TaskScheduler, validateManifest, resolveAssetUrl,
} from '@stream3d/core';
import type { AssetInput, AssetLevel, AssetManifest } from '@stream3d/core';
import type { ModelLoader, ModelTemplate, RuntimeBudgets } from './types.js';
import { NetworkMonitor } from './network.js';

export function abortError(message = 'Operation aborted'): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

export function assertLive(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? abortError();
}

export function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function objectMaterials(object: Object3D): Material[] {
  const material = (object as Mesh).material;
  return material ? (Array.isArray(material) ? material : [material]) : [];
}

export function collectTextures(root: Object3D): Set<Texture> {
  const textures = new Set<Texture>();
  root.traverse(object => {
    for (const material of objectMaterials(object)) {
      for (const value of Object.values(material)) {
        if (value instanceof Texture) textures.add(value);
      }
    }
  });
  return textures;
}

/** Source geometry/textures are shared; per-instance materials and skeletons are not. */
export function instantiateTemplate(template: ModelTemplate): Object3D {
  const root = cloneSkeleton(template.scene);
  const materials = new Map<Material, Material>();
  root.traverse(object => {
    const mesh = object as Mesh;
    // Rest-pose bounds do not describe the complete animation envelope.
    if ((object as SkinnedMesh).isSkinnedMesh) object.frustumCulled = false;
    if (!mesh.material) return;
    const cloneMaterial = (source: Material) => {
      let material = materials.get(source);
      if (!material) {
        material = source.clone();
        materials.set(source, material);
      }
      return material;
    };
    mesh.material = Array.isArray(mesh.material)
      ? mesh.material.map(cloneMaterial)
      : cloneMaterial(mesh.material);
  });
  return root;
}

/** GLTFLoader may bind unnamed nodes by UUID. Cloned instances have different UUIDs. */
export function instanceAnimations(template: ModelTemplate, instance: Object3D): AnimationClip[] {
  const sourceNodes: Object3D[] = [];
  const clonedNodes: Object3D[] = [];
  template.scene.traverse(node => sourceNodes.push(node));
  instance.traverse(node => clonedNodes.push(node));
  const ids = new Map(sourceNodes.map((node, index) => [node.uuid, clonedNodes[index]!.uuid]));
  return template.animations.map(clip => {
    let changed = false;
    const tracks = clip.tracks.map(track => {
      const separator = track.name.indexOf('.');
      const node = separator === -1 ? track.name : track.name.slice(0, separator);
      const replacement = ids.get(node);
      if (!replacement) return track;
      changed = true;
      const copy = track.clone();
      copy.name = replacement + track.name.slice(node.length);
      return copy;
    });
    return changed ? new AnimationClip(clip.name, clip.duration, tracks, clip.blendMode) : clip;
  });
}

export function disposeInstance(root: Object3D): void {
  const materials = new Set<Material>();
  root.traverse(object => {
    for (const material of objectMaterials(object)) materials.add(material);
    if ((object as SkinnedMesh).isSkinnedMesh) (object as SkinnedMesh).skeleton.dispose();
    if ('isInstancedMesh' in object && 'dispose' in object) {
      (object as Object3D & { dispose(): void }).dispose();
    }
  });
  for (const material of materials) material.dispose();
  root.removeFromParent();
}

export function disposeTemplate(template: ModelTemplate): void {
  const geometries = new Set<BufferGeometry>();
  const materials = new Set<Material>();
  const textures = new Set<Texture>();
  const images = new Set<object>();
  const skeletons = new Set<SkinnedMesh['skeleton']>();
  for (const root of new Set([template.scene, ...(template.scenes ?? [])])) {
    for (const texture of collectTextures(root)) textures.add(texture);
    root.traverse(object => {
      const mesh = object as Mesh;
      if (mesh.geometry) geometries.add(mesh.geometry);
      for (const material of objectMaterials(object)) materials.add(material);
      if ((object as SkinnedMesh).isSkinnedMesh) skeletons.add((object as SkinnedMesh).skeleton);
      if ('isInstancedMesh' in object && 'dispose' in object) {
        (object as Object3D & { dispose(): void }).dispose();
      }
    });
  }
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
  for (const skeleton of skeletons) skeleton.dispose();
  for (const texture of textures) {
    const image: unknown = texture.source?.data;
    if (image && typeof image === 'object') images.add(image);
    texture.dispose();
  }
  for (const image of images) {
    if ('close' in image && typeof image.close === 'function') image.close();
  }
}

let workerOwners = 0;
function acquireMeshoptWorkers(requested: number): () => void {
  if (requested <= 0 || typeof Worker === 'undefined') return () => {};
  if (workerOwners === 0) {
    try { MeshoptDecoder.useWorkers(requested); }
    catch { return () => {}; } // CSP may disallow blob workers; decoding still works.
  }
  workerOwners++;
  return () => {
    workerOwners--;
    if (workerOwners === 0) MeshoptDecoder.useWorkers(0);
  };
}

export class AssetResources {
  readonly network = new TaskScheduler({ concurrency: 4 });
  readonly networkMonitor = new NetworkMonitor();
  readonly decode: TaskScheduler;
  readonly bytes: ResourcePool<ArrayBuffer>;
  readonly representations: ResourcePool<ModelTemplate>;
  readonly manifests: ResourcePool<AssetManifest>;
  readonly baseUrl: string;
  private readonly loader: ModelLoader;
  private readonly releaseWorkers: () => void;

  constructor(options: {
    budgets: RuntimeBudgets;
    baseUrl: string;
    loader?: ModelLoader;
    meshoptWorkers: number;
    now: () => number;
  }) {
    this.baseUrl = options.baseUrl;
    this.decode = new TaskScheduler({ concurrency: options.budgets.decodeConcurrency });
    this.bytes = new ResourcePool({
      maxBytes: options.budgets.cacheBytes, idleMs: 60_000,
      dispose: () => {}, now: options.now,
    });
    this.representations = new ResourcePool({
      maxBytes: options.budgets.gpuBytes, idleMs: 10_000,
      dispose: disposeTemplate, now: options.now,
    });
    this.manifests = new ResourcePool({
      maxBytes: 2 * 1024 * 1024, idleMs: 60_000,
      dispose: () => {}, now: options.now,
    });
    this.releaseWorkers = acquireMeshoptWorkers(options.meshoptWorkers);
    const gltfLoader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    this.loader = options.loader ?? (async ({ level, signal }) => {
      const lease = this.bytes.acquire(level.url, async byteSignal => {
        const value = await this.network.schedule(
          requestSignal => this.networkMonitor.fetchBytes(level.url, requestSignal),
          { priority: 10, signal: byteSignal },
        );
        return { value, bytes: value.byteLength };
      }, { signal });
      try {
        const data = await lease.value;
        assertLive(signal);
        return await this.decode.schedule(async decodeSignal => {
          assertLive(decodeSignal);
          const gltf = await gltfLoader.parseAsync(data, new URL('.', level.url).href);
          const template: ModelTemplate = {
            scene: gltf.scene, scenes: gltf.scenes, animations: gltf.animations,
          };
          if (decodeSignal.aborted) {
            disposeTemplate(template);
            throw decodeSignal.reason ?? abortError();
          }
          return template;
        }, { priority: 10, signal, onDiscard: disposeTemplate });
      } finally {
        lease.release();
      }
    });
  }

  async resolve(input: AssetInput, signal: AbortSignal): Promise<AssetManifest> {
    if (typeof input !== 'string') {
      assertLive(signal);
      return this.resolveUrls(validateManifest(input), this.baseUrl);
    }
    const url = resolveAssetUrl(input, this.baseUrl);
    const lease = this.manifests.acquire(url, async manifestSignal => {
      const data = await this.network.schedule(
        requestSignal => this.networkMonitor.fetchBytes(url, requestSignal),
        { priority: 20, signal: manifestSignal },
      );
      const text = new TextDecoder().decode(data);
      const value = this.resolveUrls(validateManifest(JSON.parse(text) as unknown), url);
      return { value, bytes: text.length * 2 };
    }, { signal });
    try { return await lease.value; }
    finally { lease.release(); }
  }

  private resolveUrls(manifest: AssetManifest, base: string): AssetManifest {
    return {
      ...manifest,
      levels: manifest.levels.map(level => ({ ...level, url: resolveAssetUrl(level.url, base) })),
    };
  }

  key(manifest: AssetManifest, level: AssetLevel): string {
    return `${manifest.id}:${level.url}`;
  }

  acquire(manifest: AssetManifest, level: AssetLevel, signal?: AbortSignal) {
    return this.representations.acquire(this.key(manifest, level), async loadSignal => {
      const value = await this.loader({ manifest, level, signal: loadSignal });
      return { value, bytes: Math.max(1, value.estimatedBytes ?? level.estimatedGpuBytes) };
    }, { signal });
  }

  sweep(): void {
    this.bytes.sweep();
    this.manifests.sweep();
    this.representations.sweep();
  }

  clearCache() {
    return {
      representations: this.representations.clearIdle(),
      bytes: this.bytes.clearIdle(),
      manifests: this.manifests.clearIdle(),
    };
  }

  dispose(): void {
    this.representations.dispose();
    this.manifests.dispose();
    this.bytes.dispose();
    this.network.dispose();
    this.decode.dispose();
    this.releaseWorkers();
  }
}
