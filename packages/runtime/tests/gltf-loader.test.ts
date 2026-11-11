import { afterEach, expect, it, vi } from 'vitest';
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { meshopt } from '@gltf-transform/functions';
import { MeshoptEncoder } from 'meshoptimizer';
import { createApp } from '../src/index.js';
import type { AssetManifest, StreamApp } from '../src/index.js';
import { Mesh, Vector3 } from 'three';

let app: StreamApp | undefined;
afterEach(() => { app?.destroy(); app = undefined; vi.unstubAllGlobals(); });

async function makeGlb(): Promise<Uint8Array> {
  const document = new Document();
  const buffer = document.createBuffer();
  const positions = document.createAccessor().setType('VEC3').setBuffer(buffer)
    .setArray(new Float32Array([-1, -1, 0, 1, -1, 0, 0, 1, 0]));
  const indices = document.createAccessor().setType('SCALAR').setBuffer(buffer)
    .setArray(new Uint16Array([0, 1, 2]));
  const primitive = document.createPrimitive().setAttribute('POSITION', positions).setIndices(indices);
  const node = document.createNode().setMesh(document.createMesh().addPrimitive(primitive));
  document.createScene().addChild(node);
  const time = document.createAccessor().setType('SCALAR').setBuffer(buffer).setArray(new Float32Array([0, 1]));
  const translation = document.createAccessor().setType('VEC3').setBuffer(buffer)
    .setArray(new Float32Array([0, 0, 0, 1, 0, 0]));
  const sampler = document.createAnimationSampler().setInput(time).setOutput(translation);
  const channel = document.createAnimationChannel().setTargetNode(node).setTargetPath('translation').setSampler(sampler);
  document.createAnimation('Idle').addSampler(sampler).addChannel(channel);
  await MeshoptEncoder.ready;
  await document.transform(meshopt({ encoder: MeshoptEncoder }));
  return new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder }).writeBinary(document);
}

it('decodes real Meshopt GLB bytes, animates clones, and reuses downloaded bytes after template eviction', async () => {
  const glb = await makeGlb();
  const fetchMock = vi.fn(async () => new Response(glb as Uint8Array<ArrayBuffer>));
  vi.stubGlobal('fetch', fetchMock);
  class Canvas extends EventTarget {
    width = 640; height = 480; clientWidth = 640; clientHeight = 480;
    getBoundingClientRect() { return { left: 0, top: 0, width: 640, height: 480 }; }
  }
  let time = 0;
  app = createApp({
    canvas: new Canvas() as unknown as HTMLCanvasElement,
    renderer: { setSize() {}, render() {}, dispose() {} },
    autoStart: false, meshoptWorkers: 0, now: () => time,
  });
  const asset: AssetManifest = {
    format: 'stream3d', version: 1, id: 'real-meshopt', name: 'Triangle',
    bounds: { min: [-1, -1, 0], max: [1, 1, 0] }, animations: ['Idle'],
    levels: [{ id: 'preview', url: 'https://assets.example.test/triangle.glb',
      byteLength: glb.byteLength, estimatedGpuBytes: 1024, triangles: 1, minScreenCoverage: 0 }],
  };
  const scene = app.createScene();
  let model = scene.addModel(asset);
  model.animation.play('Idle');
  app.present(scene);
  const flush = async () => {
    for (let i = 0; i < 80; i++) { await Promise.resolve(); app!.tick(0); }
  };
  await flush();
  await model.ready();
  app.tick(0.1);
  let mesh: Mesh | undefined;
  model.object3D.traverse(object => { if ((object as Mesh).isMesh) mesh = object as Mesh; });
  expect(mesh).toBeDefined();
  expect(mesh!.geometry.getAttribute('position').count).toBe(3);
  // Meshopt quantization may add a child transform; the animated prefab node remains its parent.
  expect(mesh!.getWorldPosition(new Vector3()).x).toBeCloseTo(0.1);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(app.diagnostics().network.requestsCompleted).toBe(1);
  expect(app.diagnostics().network.bytesReceived).toBe(glb.byteLength);

  model.destroy();
  time = 11_000;
  app.tick(0);
  expect(app.diagnostics().resources.entries).toBe(0);
  expect(app.diagnostics().bytes.entries).toBe(1);
  model = scene.addModel(asset);
  await flush();
  await model.ready();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(app.diagnostics().bytes.hits).toBeGreaterThanOrEqual(1);
  expect(app.diagnostics().resources.misses).toBe(2);
  expect(app.diagnostics().network.requestsStarted).toBe(1);
  expect(app.diagnostics().network.bytesReceived).toBe(glb.byteLength);

  model.destroy();
  const cleared = app.clearCache();
  expect(cleared.representations.entries).toBe(1);
  expect(cleared.bytes).toEqual({ entries: 1, bytes: glb.byteLength });
  model = scene.addModel(asset);
  await flush();
  await model.ready();
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(app.diagnostics().network.requestsCompleted).toBe(2);
  expect(app.diagnostics().network.bytesReceived).toBe(glb.byteLength * 2);
});
