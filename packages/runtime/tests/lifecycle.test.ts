import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AnimationClip, Bone, BoxGeometry, Group, Mesh, MeshStandardMaterial,
  NumberKeyframeTrack, Skeleton, SkinnedMesh, Texture,
} from 'three';
import { createApp } from '../src/index.js';
import type { AppOptions, ModelTemplate, RendererBackend, StreamApp } from '../src/index.js';
import type { AssetManifest } from '@stream3d/core';
import { disposeTemplate, instanceAnimations, instantiateTemplate } from '../src/resources.js';

class FakeCanvas extends EventTarget {
  width = 640;
  height = 480;
  clientWidth = 640;
  clientHeight = 480;
  getBoundingClientRect() { return { left: 0, top: 0, width: 640, height: 480 }; }
}

function manifest(animated = false): AssetManifest {
  return {
    format: 'stream3d', version: 1, id: 'fixture-shared', name: 'Robot',
    bounds: { min: [-1, -1, -1], max: [1, 1, 1] },
    animations: animated ? ['Idle'] : [],
    levels: [
      { id: 'preview', url: 'preview.glb', byteLength: 10, estimatedGpuBytes: 100, triangles: 12, minScreenCoverage: 0 },
      { id: 'standard', url: 'standard.glb', byteLength: 20, estimatedGpuBytes: 200, triangles: 24, minScreenCoverage: 0.25 },
      { id: 'full', url: 'full.glb', byteLength: 40, estimatedGpuBytes: 400, triangles: 48, minScreenCoverage: 0.65 },
    ],
  };
}

function template(animated = false, unnamed = false): ModelTemplate {
  const scene = new Group();
  const body = new Mesh(new BoxGeometry(), new MeshStandardMaterial({ color: '#ffffff' }));
  body.name = unnamed ? '' : 'Pivot';
  body.material.name = 'Body';
  scene.add(body);
  return {
    scene,
    animations: animated ? [new AnimationClip('Idle', 10, [
      new NumberKeyframeTrack(`${unnamed ? body.uuid : 'Pivot'}.rotation[y]`, [0, 10], [0, 6]),
    ])] : [],
  };
}

function backend(): RendererBackend {
  return { setSize: vi.fn(), render: vi.fn(), dispose: vi.fn() };
}

const apps: StreamApp[] = [];
function setup(options: Partial<AppOptions> = {}) {
  const renderer = options.renderer ?? backend();
  let time = 0;
  const app = createApp({
    canvas: new FakeCanvas() as unknown as HTMLCanvasElement,
    autoStart: false, renderer, meshoptWorkers: 0,
    refinementDelayMs: 10, offscreenGraceMs: 0,
    now: () => time,
    loader: async () => template(),
    ...options,
  });
  apps.push(app);
  return { app, renderer, setTime: (value: number) => { time = value; } };
}

async function flush(app: StreamApp, count = 15) {
  for (let i = 0; i < count; i++) { await Promise.resolve(); app.tick(0); }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

afterEach(() => {
  for (const app of apps.splice(0)) app.destroy();
  vi.unstubAllGlobals();
});

describe('managed model lifecycle', () => {
  it('creates stable handles without loading inactive scenes and presents coarse first', async () => {
    const calls: string[] = [];
    const { app, setTime } = setup({ loader: async ({ level }) => { calls.push(level.id); return template(); } });
    const scene = app.createScene();
    const robot = scene.addModel(manifest());
    const root = robot.object3D;
    robot.position.set(0.25, 0, 0);
    await flush(app);
    expect(calls).toEqual([]);
    expect(app.diagnostics().resources.activeLeases).toBe(0);
    app.present(scene);
    await flush(app);
    await robot.ready('interactive');
    expect(calls).toEqual(['preview']);
    expect(robot.currentLevel).toBe(0);
    setTime(20);
    await flush(app, 30);
    expect(calls).toEqual(['preview', 'standard', 'full']);
    expect(robot.currentLevel).toBe(2);
    expect(robot.object3D).toBe(root);
    expect(robot.position.x).toBe(0.25);
    expect(root.children).toHaveLength(1);
  });

  it('shares one template but creates independent material and animation state', async () => {
    const sources: ModelTemplate[] = [];
    const loader = vi.fn(async () => { const source = template(true); sources.push(source); return source; });
    const { app } = setup({ loader });
    const scene = app.createScene();
    const a = scene.addModel(manifest(true));
    const b = scene.addModel(manifest(true));
    a.materials.set('Body', { color: '#ff0000' });
    b.materials.set('Body', { color: '#0000ff' });
    a.animation.play('Idle');
    app.present(scene);
    await flush(app);
    expect(loader).toHaveBeenCalledTimes(1);
    const meshA = a.object3D.getObjectByName('Pivot') as Mesh<BoxGeometry, MeshStandardMaterial>;
    const meshB = b.object3D.getObjectByName('Pivot') as Mesh<BoxGeometry, MeshStandardMaterial>;
    expect(meshA.geometry).toBe(meshB.geometry);
    expect(meshA.material).not.toBe(meshB.material);
    expect(meshA.material.color.getHexString()).toBe('ff0000');
    expect(meshB.material.color.getHexString()).toBe('0000ff');
    expect((sources[0]!.scene.children[0] as Mesh<BoxGeometry, MeshStandardMaterial>).material.color.getHexString()).toBe('ffffff');
    app.tick(0.1);
    expect(a.animation.time).toBeCloseTo(0.1);
    expect(b.animation.time).toBe(0);
    expect(meshA.rotation.y).toBeGreaterThan(0);
    expect(meshB.rotation.y).toBe(0);
    expect(app.diagnostics().resources.activeLeases).toBe(2);
  });

  it('preserves material overrides and animation progress through LOD replacement', async () => {
    const { app, setTime } = setup({ loader: async () => template(true) });
    const scene = app.createScene();
    const model = scene.addModel(manifest(true));
    model.animation.play('Idle');
    model.materials.set('Body', { color: '#12ab34', roughness: 0.2 });
    app.present(scene);
    await flush(app);
    app.tick(0.1);
    app.tick(0.1);
    const previous = model.object3D.getObjectByName('Pivot')!;
    const rotation = previous.rotation.y;
    setTime(20);
    await flush(app, 35);
    const next = model.object3D.getObjectByName('Pivot') as Mesh<BoxGeometry, MeshStandardMaterial>;
    expect(model.currentLevel).toBe(2);
    expect(next).not.toBe(previous);
    expect(model.animation.time).toBeCloseTo(0.2);
    expect(next.rotation.y).toBeCloseTo(rotation);
    expect(next.material.color.getHexString()).toBe('12ab34');
    expect(next.material.roughness).toBe(0.2);
  });

  it('cancels one subscriber without aborting a shared load needed by another model', async () => {
    const result = deferred<ModelTemplate>();
    let signal!: AbortSignal;
    const loader = vi.fn(async context => { signal = context.signal; return result.promise; });
    const { app } = setup({ loader });
    const scene = app.createScene();
    const a = scene.addModel(manifest());
    const b = scene.addModel(manifest());
    app.present(scene);
    await flush(app);
    const rejected = expect(a.ready()).rejects.toMatchObject({ name: 'AbortError' });
    a.destroy();
    await rejected;
    expect(signal.aborted).toBe(false);
    result.resolve(template());
    await flush(app);
    await b.ready();
    expect(loader).toHaveBeenCalledTimes(1);
    expect(a.object3D.children).toHaveLength(0);
    expect(b.currentLevel).toBe(0);
    expect(app.diagnostics().resources.activeLeases).toBe(1);
  });

  it('disposes a late source once after its last pending consumer is destroyed', async () => {
    const result = deferred<ModelTemplate>();
    const source = template();
    const geometry = (source.scene.children[0] as Mesh).geometry;
    const disposed = vi.fn();
    geometry.addEventListener('dispose', disposed);
    const { app } = setup({ loader: async () => result.promise });
    const scene = app.createScene();
    const model = scene.addModel(manifest());
    app.present(scene);
    await flush(app);
    model.destroy();
    result.resolve(source);
    await flush(app);
    expect(disposed).toHaveBeenCalledTimes(1);
    expect(model.object3D.children).toHaveLength(0);
    expect(app.diagnostics().resources.activeLeases).toBe(0);
    expect(app.diagnostics().resources.bytes).toBe(0);
  });

  it('keeps the working coarse representation when a better level fails', async () => {
    const calls: string[] = [];
    const { app, setTime } = setup({
      loader: async ({ level }) => {
        calls.push(level.id);
        if (level.id === 'standard') throw new Error('temporary offline');
        return template();
      },
    });
    const scene = app.createScene();
    const model = scene.addModel(manifest());
    const errors = vi.fn();
    model.on('error', errors);
    app.present(scene);
    await flush(app);
    setTime(20);
    await flush(app, 30);
    expect(model.currentLevel).toBe(0);
    expect(model.object3D.children).toHaveLength(1);
    expect(calls).toEqual(['preview', 'standard']);
    expect(errors).toHaveBeenCalledTimes(1);
    expect(app.diagnostics().levels[0]!.error).toBe('temporary offline');
    await model.ready();
  });

  it('cancels an obsolete upgrade even when the current level already matches the new budget', async () => {
    const upgrade = deferred<ModelTemplate>();
    let upgradeSignal: AbortSignal | undefined;
    const { app, setTime } = setup({
      loader: async ({ level, signal }) => {
        if (level.id === 'preview') return template();
        upgradeSignal = signal;
        return upgrade.promise;
      },
    });
    const scene = app.createScene();
    const model = scene.addModel(manifest());
    app.present(scene);
    await flush(app);
    const original = model.object3D.children[0];
    setTime(20);
    await flush(app);
    expect(model.pendingLevel).toBe(1);
    app.setBudgets({ gpuBytes: 150 });
    expect(upgradeSignal?.aborted).toBe(true);
    upgrade.resolve(template());
    await flush(app);
    expect(model.currentLevel).toBe(0);
    expect(model.object3D.children[0]).toBe(original);
    expect(model.pendingLevel).toBe(null);
  });

  it('applies the latest material edit made during asynchronous GPU preparation', async () => {
    const preparation = deferred<void>();
    let compiledVersion = -1;
    const renderer = {
      ...backend(),
      compileAsync: vi.fn(async object => {
        const mesh = object.getObjectByName('Pivot') as Mesh<BoxGeometry, MeshStandardMaterial>;
        compiledVersion = mesh.material.version;
        return preparation.promise;
      }),
    };
    const { app } = setup({ renderer });
    const scene = app.createScene();
    const model = scene.addModel(manifest());
    app.present(scene);
    await flush(app);
    expect(renderer.compileAsync).toHaveBeenCalledTimes(1);
    model.materials.set('Body', { color: '#ffaa00' });
    preparation.resolve();
    await flush(app);
    const mesh = model.object3D.getObjectByName('Pivot') as Mesh<BoxGeometry, MeshStandardMaterial>;
    expect(mesh.material.color.getHexString()).toBe('ffaa00');
    expect(mesh.material.version).toBe(compiledVersion);
  });

  it('keeps a source leased until uninterruptible preparation finishes after cancellation', async () => {
    const preparation = deferred<void>();
    const source = template();
    const disposed = vi.spyOn((source.scene.children[0] as Mesh).geometry, 'dispose');
    const { app } = setup({
      renderer: { ...backend(), compileAsync: async () => preparation.promise },
      loader: async () => source,
      budgets: { gpuBytes: 50 },
    });
    const scene = app.createScene();
    const model = scene.addModel(manifest());
    app.present(scene);
    await flush(app);
    model.destroy();
    expect(disposed).not.toHaveBeenCalled();
    expect(app.diagnostics().resources.activeLeases).toBe(1);
    preparation.resolve();
    await flush(app);
    expect(disposed).toHaveBeenCalledTimes(1);
    expect(app.diagnostics().resources.activeLeases).toBe(0);
  });

  it('deduplicates identical representation URLs across quality tiers', async () => {
    const loader = vi.fn(async () => template());
    const { app, setTime } = setup({ loader });
    const asset = manifest();
    asset.levels = asset.levels.map(level => ({ ...level, url: 'same-content.glb', estimatedGpuBytes: 100 }));
    const scene = app.createScene();
    const model = scene.addModel(asset);
    app.present(scene);
    await flush(app);
    const original = model.object3D.children[0];
    setTime(20);
    await flush(app, 30);
    expect(model.currentLevel).toBe(2);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(model.object3D.children[0]).toBe(original);
    expect(app.diagnostics().resources.bytes).toBe(100);
    expect(app.diagnostics().resources.activeLeases).toBe(1);
  });

  it('automatically downgrades after a budget change and reports mandatory coarse pressure', async () => {
    const { app, setTime } = setup();
    const scene = app.createScene();
    const model = scene.addModel(manifest());
    app.present(scene);
    await flush(app);
    setTime(20);
    await flush(app, 35);
    expect(model.currentLevel).toBe(2);
    app.setBudgets({ gpuBytes: 250 });
    await flush(app);
    expect(model.currentLevel).toBe(1);
    expect(app.diagnostics().resources.bytes).toBeLessThanOrEqual(250);
    app.setBudgets({ gpuBytes: 50 });
    await flush(app);
    expect(model.currentLevel).toBe(0);
    expect(app.diagnostics().gpuPressure).toBe(true);
    expect(app.diagnostics().resources.activeLeases).toBe(1);
  });

  it('releases offscreen static payloads, evicts idle templates and restores logical state', async () => {
    const loader = vi.fn(async () => template());
    const { app, setTime } = setup({ loader });
    const scene = app.createScene();
    const model = scene.addModel(manifest());
    model.materials.set('Body', { color: '#ff0000' });
    app.present(scene);
    await flush(app);
    model.position.x = 100;
    app.tick(0);
    expect(model.currentLevel).toBe(null);
    expect(model.object3D.parent).toBe(scene.root);
    expect(app.diagnostics().resources.activeLeases).toBe(0);
    setTime(11_000);
    app.tick(0);
    expect(app.diagnostics().resources.entries).toBe(0);
    model.position.x = 0;
    await flush(app);
    expect(loader).toHaveBeenCalledTimes(2);
    const mesh = model.object3D.getObjectByName('Pivot') as Mesh<BoxGeometry, MeshStandardMaterial>;
    expect(mesh.material.color.getHexString()).toBe('ff0000');
  });

  it('uses conservative animated visibility when only rest-pose bounds are known', async () => {
    const { app } = setup({ loader: async () => template(true) });
    const scene = app.createScene();
    const model = scene.addModel(manifest(true));
    model.position.x = 100;
    app.present(scene);
    await flush(app);
    expect(model.currentLevel).toBe(0);
    expect(model.coverage).toBe(0);
    expect(model.visible).toBe(true);
  });

  it('releases old scene demand without losing animation and transform state', async () => {
    const loader = vi.fn(async () => template(true));
    const { app } = setup({ loader });
    const first = app.createScene();
    const model = first.addModel(manifest(true));
    model.animation.play('Idle');
    app.present(first);
    await flush(app);
    app.tick(0.1);
    model.position.x = 0.3;
    const second = app.createScene();
    app.present(second);
    expect(model.currentLevel).toBe(null);
    expect(app.diagnostics().resources.activeLeases).toBe(0);
    expect(model.animation.time).toBeCloseTo(0.1);
    app.present(first);
    await flush(app);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(model.currentLevel).toBe(0);
    expect(model.position.x).toBe(0.3);
    expect(model.animation.time).toBeCloseTo(0.1);
  });

  it('hands shared pending work to an initialized next scene and cancels obsolete work', async () => {
    const shared = deferred<ModelTemplate>();
    const signals = new Map<string, AbortSignal>();
    const loader = vi.fn(async ({ manifest: asset, signal }) => {
      signals.set(asset.id, signal);
      if (asset.id === 'fixture-shared') return shared.promise;
      return new Promise<ModelTemplate>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });
    const { app, renderer } = setup({ loader });
    const first = app.createScene();
    const oldShared = first.addModel(manifest());
    const obsoleteAsset = manifest();
    obsoleteAsset.id = 'obsolete';
    obsoleteAsset.levels = obsoleteAsset.levels.map(level => ({ ...level, url: `obsolete-${level.url}` }));
    const oldObsolete = first.addModel(obsoleteAsset);
    const next = app.createScene();
    const newShared = next.addModel(manifest());
    await flush(app);
    expect(newShared.manifest).not.toBeNull();
    app.present(first);
    await flush(app);
    expect(loader).toHaveBeenCalledTimes(2);
    const oldSharedReady = expect(oldShared.ready()).rejects.toMatchObject({ name: 'AbortError' });
    const oldObsoleteReady = expect(oldObsolete.ready()).rejects.toMatchObject({ name: 'AbortError' });

    app.present(next);

    expect(signals.get('fixture-shared')!.aborted).toBe(false);
    expect(signals.get('obsolete')!.aborted).toBe(true);
    expect(oldShared.visible).toBe(false);
    expect(oldObsolete.visible).toBe(false);
    expect(newShared.visible).toBe(true);
    expect(app.diagnostics().activeModels).toBe(1);
    expect(app.diagnostics().resources.activeLeases).toBe(1);
    expect(renderer.render).toHaveBeenLastCalledWith(next.root, next.camera);
    await Promise.all([oldSharedReady, oldObsoleteReady]);

    shared.resolve(template());
    await flush(app);
    await newShared.ready();
    expect(loader).toHaveBeenCalledTimes(2);
    expect(newShared.currentLevel).toBe(0);
    expect(oldShared.object3D.children).toHaveLength(0);
    expect(oldObsolete.object3D.children).toHaveLength(0);
  });

  it('does not retain old pending work speculatively when the next manifest is unresolved', async () => {
    const signals: AbortSignal[] = [];
    const results: ReturnType<typeof deferred<ModelTemplate>>[] = [];
    const loader = vi.fn(async ({ signal }) => {
      const result = deferred<ModelTemplate>();
      results.push(result);
      signals.push(signal);
      signal.addEventListener('abort', () => result.reject(signal.reason), { once: true });
      return result.promise;
    });
    const { app } = setup({ loader });
    const first = app.createScene();
    const old = first.addModel(manifest());
    app.present(first);
    await flush(app);
    const oldReady = expect(old.ready()).rejects.toMatchObject({ name: 'AbortError' });
    const next = app.createScene();
    const incoming = next.addModel(manifest());
    expect(incoming.manifest).toBeNull();

    app.present(next);

    expect(signals[0]!.aborted).toBe(true);
    expect(app.diagnostics().resources.activeLeases).toBe(0);
    await oldReady;
    await flush(app);
    expect(loader).toHaveBeenCalledTimes(2);
    results[1]!.resolve(template());
    await flush(app);
    await incoming.ready();
    expect(incoming.currentLevel).toBe(0);
    expect(old.object3D.children).toHaveLength(0);
  });

  it('resolves shared texture subscribers without spending additional physical upload slots', async () => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    const sources = [template(), template(), template()];
    for (const source of sources) {
      (source.scene.children[0] as Mesh<BoxGeometry, MeshStandardMaterial>).material.map = new Texture();
    }
    try {
      const renderer = { ...backend(), initTexture: vi.fn() };
      const { app } = setup({ renderer });
      const scene = app.createScene();
      const controllers = Array.from({ length: 6 }, () => new AbortController());
      const preparations = controllers.map((controller, index) => app.prepare(
        sources[index < 4 ? 0 : index - 3]!.scene, scene, controller.signal,
      ));
      const aborted = expect(preparations[3]!).rejects.toMatchObject({ name: 'AbortError' });
      controllers[3]!.abort();
      expect(app.diagnostics().pendingUploads).toBe(5);

      app.tick(0);

      expect(renderer.initTexture).toHaveBeenCalledTimes(2);
      expect(app.diagnostics().pendingUploads).toBe(1);
      await Promise.all([...preparations.slice(0, 3), preparations[4], aborted]);
      app.tick(0);
      await preparations[5];
      expect(renderer.initTexture).toHaveBeenCalledTimes(3);
      expect(app.diagnostics().pendingUploads).toBe(0);
    } finally {
      clock.mockRestore();
      for (const source of sources) disposeTemplate(source);
    }
  });

  it('clearCache removes idle templates while protecting the currently rendered lease', async () => {
    const { app } = setup();
    const first = app.createScene();
    const firstModel = first.addModel(manifest());
    const second = app.createScene();
    const other = manifest();
    other.id = 'other-asset';
    other.levels = other.levels.map(level => ({ ...level, url: `other-${level.url}` }));
    const secondModel = second.addModel(other);
    app.present(first);
    await flush(app);
    app.present(second);
    await flush(app);
    expect(app.diagnostics().resources.entries).toBe(2);
    const cleared = app.clearCache();
    expect(cleared.representations).toEqual({ entries: 1, bytes: 100 });
    expect(app.diagnostics().resources.entries).toBe(1);
    expect(app.diagnostics().resources.activeLeases).toBe(1);
    expect(secondModel.currentLevel).toBe(0);
    expect(secondModel.object3D.children).toHaveLength(1);
    expect(firstModel.currentLevel).toBe(null);
    expect(app.clearCache().representations).toEqual({ entries: 0, bytes: 0 });
  });

  it('measures coarse preparation elapsed time without including later refinement', async () => {
    const loaded = deferred<ModelTemplate>();
    const clock = vi.spyOn(performance, 'now').mockReturnValue(10);
    try {
      const { app } = setup({ loader: async () => loaded.promise });
      const scene = app.createScene();
      const model = scene.addModel(manifest());
      app.present(scene);
      await flush(app);
      expect(model.timing).toEqual({ firstReadyMs: null, lastReadyMs: null });
      clock.mockReturnValue(85);
      loaded.resolve(template());
      await flush(app);
      expect(model.timing).toEqual({ firstReadyMs: 75, lastReadyMs: 75 });
      expect(app.diagnostics().levels[0]!.timing.firstReadyMs).toBe(75);
      const snapshot = model.timing;
      snapshot.firstReadyMs = 1;
      expect(model.timing.firstReadyMs).toBe(75);
    } finally { clock.mockRestore(); }
  });

  it('resolves fetched manifest asset URLs against the manifest location', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(manifest())));
    vi.stubGlobal('fetch', fetchMock);
    const urls: string[] = [];
    const { app } = setup({ loader: async ({ level }) => { urls.push(level.url); return template(); } });
    const scene = app.createScene();
    const model = scene.addModel('https://assets.example.test/robot/manifest.json');
    app.present(scene);
    await flush(app, 40);
    await model.ready();
    expect(urls).toEqual(['https://assets.example.test/robot/preview.glb']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('counts real UTF-8 manifest bytes once for shared loads, and clearCache resets idle manifest caching', async () => {
    const asset = manifest();
    asset.name = '角色 🐉';
    const json = JSON.stringify(asset);
    const length = new TextEncoder().encode(json).byteLength;
    const fetchMock = vi.fn(async () => new Response(json));
    vi.stubGlobal('fetch', fetchMock);
    const { app } = setup();
    const scene = app.createScene();
    const url = 'https://assets.example.test/robot/manifest.json';
    scene.addModel(url);
    scene.addModel(url);
    await flush(app, 40);
    expect(app.diagnostics().network).toEqual({
      requestsStarted: 1, requestsCompleted: 1, requestsAborted: 0, requestsFailed: 0,
      requestsActive: 0, bytesReceived: length, bytesCompleted: length,
    });
    expect(length).toBeGreaterThan(json.length);
    expect(app.clearCache().manifests.entries).toBe(1);
    scene.addModel(url);
    await flush(app, 40);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(app.diagnostics().network.bytesReceived).toBe(length * 2);
  });

  it('aborts a partial GLB response when the app is destroyed and retains accurate partial-byte totals', async () => {
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ start(controller) { stream = controller; }, cancel });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body)));
    const { app } = setup({ loader: undefined });
    const scene = app.createScene();
    const model = scene.addModel(manifest());
    const rejection = expect(model.ready()).rejects.toMatchObject({ name: 'AbortError' });
    app.present(scene);
    stream.enqueue(new Uint8Array(11));
    await flush(app, 40);
    expect(app.diagnostics().network.bytesReceived).toBe(11);
    expect(app.diagnostics().network.requestsActive).toBe(1);
    app.destroy();
    await rejection;
    await flush(app, 40);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(app.diagnostics().network).toEqual({
      requestsStarted: 1, requestsCompleted: 0, requestsAborted: 1, requestsFailed: 0,
      requestsActive: 0, bytesReceived: 11, bytesCompleted: 0,
    });
  });

  it('rejects malformed manifests rather than mounting an invalid model', async () => {
    const loader = vi.fn(async () => template());
    const { app } = setup({ loader });
    const scene = app.createScene();
    const invalid = { ...manifest(), levels: [] };
    const model = scene.addModel(invalid);
    const ready = expect(model.ready()).rejects.toThrow('at least one representation');
    app.present(scene);
    await flush(app);
    await ready;
    expect(loader).not.toHaveBeenCalled();
  });

  it('removes canvas listeners and destroys the renderer exactly once', async () => {
    const canvas = new FakeCanvas();
    const add = vi.spyOn(canvas, 'addEventListener');
    const remove = vi.spyOn(canvas, 'removeEventListener');
    const renderer = backend();
    const { app } = setup({ canvas: canvas as unknown as HTMLCanvasElement, renderer });
    app.destroy();
    app.destroy();
    expect(renderer.dispose).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(add.mock.calls.length);
    expect(app.diagnostics().resources.activeLeases).toBe(0);
  });

  it('dispatches a click to the stable model and ignores drag gestures', async () => {
    const canvas = new FakeCanvas();
    const { app } = setup({ canvas: canvas as unknown as HTMLCanvasElement });
    const scene = app.createScene();
    const model = scene.addModel(manifest());
    const click = vi.fn();
    model.on('click', click);
    app.present(scene);
    await flush(app);
    const pointer = (type: string, x: number, y: number) => {
      const event = new Event(type);
      Object.assign(event, { pointerId: 1, button: 0, clientX: x, clientY: y });
      canvas.dispatchEvent(event);
    };
    pointer('pointerdown', 320, 240);
    pointer('pointerup', 320, 240);
    expect(click).toHaveBeenCalledTimes(1);
    expect(click.mock.calls[0]![0].model).toBe(model);
    pointer('pointerdown', 280, 240);
    pointer('pointerup', 320, 240);
    expect(click).toHaveBeenCalledTimes(1);
  });
});

describe('template ownership', () => {
  it('remaps unnamed UUID-targeted animation tracks to each instance', async () => {
    const source = template(true, true);
    const { app } = setup({ loader: async () => source });
    const scene = app.createScene();
    const model = scene.addModel(manifest(true));
    model.animation.play('Idle');
    app.present(scene);
    await flush(app);
    app.tick(0.1);
    const mesh = model.object3D.children[0]!.children[0]!;
    expect(mesh.rotation.y).toBeCloseTo(0.06);
    expect(source.scene.children[0]!.rotation.y).toBe(0);
    expect(source.animations[0]!.tracks[0]!.name).toContain(source.scene.children[0]!.uuid);
  });

  it('clones skeleton poses but shares immutable geometry', () => {
    const scene = new Group();
    const rootBone = new Bone();
    const mesh = new SkinnedMesh(new BoxGeometry(), new MeshStandardMaterial());
    mesh.add(rootBone);
    mesh.bind(new Skeleton([rootBone]));
    scene.add(mesh);
    const source = { scene, animations: [] };
    const a = instantiateTemplate(source).children[0] as SkinnedMesh;
    const b = instantiateTemplate(source).children[0] as SkinnedMesh;
    expect(a.geometry).toBe(b.geometry);
    expect(a.skeleton).not.toBe(b.skeleton);
    expect(a.skeleton.bones[0]).not.toBe(b.skeleton.bones[0]);
    expect(a.frustumCulled).toBe(false);
    a.skeleton.bones[0]!.position.x = 5;
    expect(b.skeleton.bones[0]!.position.x).toBe(0);
    disposeTemplate(source);
  });

  it('closes each shared decoded image once and disposes shared resources once', () => {
    const source = template();
    const mesh = source.scene.children[0] as Mesh<BoxGeometry, MeshStandardMaterial>;
    const close = vi.fn();
    const image = { width: 4, height: 4, close };
    const textureA = new Texture(image);
    const textureB = new Texture(image);
    mesh.material.map = textureA;
    mesh.material.normalMap = textureB;
    const geometryDispose = vi.spyOn(mesh.geometry, 'dispose');
    source.scenes = [source.scene];
    disposeTemplate(source);
    expect(geometryDispose).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });
});
