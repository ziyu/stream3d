/**
 * Deterministic, original architectural / botanical / mechanical demonstration assets.
 * No downloads, licensed source meshes, payload padding, or synthetic rendering loops.
 * Run with: node --import tsx scripts/generate-showcase.ts
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { Document, NodeIO } from '@gltf-transform/core';
import type { Accessor, Animation, Material, Mesh as GLTFMesh, Node as GLTFNode, Texture } from '@gltf-transform/core';
import { Box3, Matrix4, Mesh, MeshStandardMaterial } from 'three';
import type { BufferGeometry, Object3D } from 'three';
import { pavilion, reactor, luminaire } from './showcase/architecture.js';
import { canopy, terrain, coral } from './showcase/nature.js';
import { combine, mesh } from './showcase/shared.js';
import type { Kit, TextureKind } from './showcase/shared.js';
import { generateTexture } from './showcase/textures.js';
import type { TextureImage } from './showcase/textures.js';

const output = fileURLToPath(new URL('../examples/playground/assets/showcase/', import.meta.url));
const metadataPath = fileURLToPath(new URL('./showcase/metadata.ts', import.meta.url));
const receiptPath = join(output, 'receipt.json');
const names = ['pavilion', 'reactor', 'canopy', 'terrain', 'coral', 'luminaire'];
const sourceFiles = ['./generate-showcase.ts', './showcase/shared.ts', './showcase/textures.ts', './showcase/architecture.ts', './showcase/nature.ts'];
const sourceHash = createHash('sha256');
for (const file of sourceFiles) sourceHash.update(await readFile(new URL(file, import.meta.url)));
const fingerprint = sourceHash.digest('hex');

async function writeIfChanged(destination: string, bytes: Uint8Array | string): Promise<void> {
  const next = typeof bytes === 'string' ? Buffer.from(bytes) : Buffer.from(bytes);
  const previous = await readFile(destination).catch(() => undefined);
  if (previous?.equals(next)) return;
  const temporary = `${destination}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, next);
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

interface AssetMetadata {
  name: string;
  title: string;
  description: string;
  file: string;
  sourceBytes: number;
  uniqueTriangles: number;
  drawnTriangles: number;
  originalUniqueTriangles: number;
  originalPartCount: number;
  meshCount: number;
  primitiveCount: number;
  bounds: { min: number[]; max: number[] };
  size: number[];
  materials: string[];
  animations: string[];
  textureSizes: Record<string, number>;
}

async function canReuse(): Promise<boolean> {
  if (process.argv.includes('--force')) return false;
  try {
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as { fingerprint: string; assets: AssetMetadata[] };
    if (receipt.fingerprint !== fingerprint || receipt.assets.length !== names.length) return false;
    for (const asset of receipt.assets) {
      if (!names.includes(asset.name) || (await stat(join(output, `${asset.name}.glb`))).size !== asset.sourceBytes) return false;
    }
    await stat(metadataPath);
    return true;
  } catch { return false; }
}

function geometryStats(root: Object3D) {
  const unique = new Set<BufferGeometry>();
  let parts = 0;
  let drawnTriangles = 0;
  root.traverse(object => {
    if (!(object instanceof Mesh)) return;
    unique.add(object.geometry);
    parts++;
    drawnTriangles += (object.geometry.getIndex()?.count ?? object.geometry.getAttribute('position').count) / 3;
  });
  return {
    uniqueTriangles: [...unique].reduce((sum, geometry) => sum + (geometry.getIndex()?.count ?? geometry.getAttribute('position').count) / 3, 0),
    drawnTriangles,
    parts,
  };
}

/** Batch static parts by material inside each animated assembly; animated pivots remain real nodes. */
function batchAssemblies(kit: Kit): void {
  const assemblies = new Set<Object3D>([kit.root, ...kit.motions.map(motion => motion.node)]);
  kit.root.updateMatrixWorld(true);
  const originalGeometries = new Set<BufferGeometry>();
  for (const assembly of assemblies) {
    const inverse = new Matrix4().copy(assembly.matrixWorld).invert();
    const byMaterial = new Map<MeshStandardMaterial, BufferGeometry[]>();
    const originals: Mesh[] = [];
    const visit = (object: Object3D) => {
      if (object !== assembly && assemblies.has(object)) return;
      if (object instanceof Mesh) {
        if (!(object.material instanceof MeshStandardMaterial)) throw new Error('Expected one named PBR material per authored part');
        const geometries = byMaterial.get(object.material) ?? [];
        const geometry = object.geometry.clone().applyMatrix4(new Matrix4().multiplyMatrices(inverse, object.matrixWorld));
        geometries.push(geometry);
        byMaterial.set(object.material, geometries);
        originals.push(object);
        originalGeometries.add(object.geometry);
      }
      for (const child of object.children) visit(child);
    };
    visit(assembly);
    for (const original of originals) original.removeFromParent();
    for (const [material, geometries] of byMaterial) mesh(`${assembly.name}_${material.name}`, combine(geometries), material, assembly);
  }
  for (const geometry of originalGeometries) geometry.dispose();
}

async function exportKit(kit: Kit, images: Map<TextureKind, TextureImage>): Promise<AssetMetadata> {
  const original = geometryStats(kit.root);
  batchAssemblies(kit);
  const stats = geometryStats(kit.root);
  const document = new Document();
  const buffer = document.createBuffer('Showcase_Geometry');
  const materials = new Map<MeshStandardMaterial, Material>();
  const textures = new Map<TextureKind, Texture>();
  for (const surface of kit.surfaces) {
    const source = surface.material;
    const material = document.createMaterial(source.name)
      .setBaseColorFactor([source.color.r, source.color.g, source.color.b, source.opacity])
      .setMetallicFactor(source.metalness)
      .setRoughnessFactor(source.roughness)
      .setDoubleSided(true)
      .setEmissiveFactor([source.emissive.r, source.emissive.g, source.emissive.b]);
    if (source.transparent) material.setAlphaMode('BLEND');
    if (surface.texture) {
      let texture = textures.get(surface.texture);
      if (!texture) {
        const image = images.get(surface.texture)!;
        texture = document.createTexture(surface.texture).setMimeType('image/png').setImage(image.bytes);
        textures.set(surface.texture, texture);
      }
      material.setBaseColorTexture(texture);
    }
    materials.set(source, material);
  }
  const accessor = (name: string, type: 'SCALAR' | 'VEC2' | 'VEC3' | 'VEC4', values: Float32Array<ArrayBuffer> | Uint32Array<ArrayBuffer>): Accessor =>
    document.createAccessor(name).setType(type).setArray(values).setBuffer(buffer);
  const nodes = new Map<Object3D, GLTFNode>();
  const meshes = new Map<BufferGeometry, GLTFMesh>();
  const convert = (object: Object3D): GLTFNode => {
    const node = document.createNode(object.name)
      .setTranslation(object.position.toArray())
      .setRotation(object.quaternion.toArray())
      .setScale(object.scale.toArray());
    nodes.set(object, node);
    if (object instanceof Mesh) {
      const geometry = object.geometry;
      let converted = meshes.get(geometry);
      if (!converted) {
        const primitive = document.createPrimitive()
          .setAttribute('POSITION', accessor(`${object.name}_positions`, 'VEC3', new Float32Array(geometry.getAttribute('position').array)))
          .setAttribute('NORMAL', accessor(`${object.name}_normals`, 'VEC3', new Float32Array(geometry.getAttribute('normal').array)))
          .setAttribute('TEXCOORD_0', accessor(`${object.name}_uvs`, 'VEC2', new Float32Array(geometry.getAttribute('uv').array)))
          .setMaterial(materials.get(object.material as MeshStandardMaterial)!);
        if (geometry.getIndex()) primitive.setIndices(accessor(`${object.name}_indices`, 'SCALAR', new Uint32Array(geometry.getIndex()!.array)));
        converted = document.createMesh(object.name).addPrimitive(primitive);
        meshes.set(geometry, converted);
      }
      node.setMesh(converted);
    }
    for (const child of object.children) node.addChild(convert(child));
    return node;
  };
  const scene = document.createScene(kit.title).addChild(convert(kit.root));
  document.getRoot().setDefaultScene(scene);
  const animations = new Map<string, Animation>();
  for (const motion of kit.motions) {
    let animation = animations.get(motion.name);
    if (!animation) {
      animation = document.createAnimation(motion.name);
      animations.set(motion.name, animation);
    }
    const sampler = document.createAnimationSampler(`${motion.node.name}_${motion.name}`)
      .setInput(accessor(`${motion.node.name}_times`, 'SCALAR', new Float32Array(motion.times)))
      .setOutput(accessor(`${motion.node.name}_rotations`, 'VEC4', new Float32Array(motion.rotations.flat())))
      .setInterpolation('LINEAR');
    animation.addSampler(sampler).addChannel(document.createAnimationChannel().setTargetNode(nodes.get(motion.node)!).setTargetPath('rotation').setSampler(sampler));
  }
  const bounds = new Box3().setFromObject(kit.root);
  const bytes = await new NodeIO().writeBinary(document);
  await writeIfChanged(join(output, `${kit.name}.glb`), bytes);
  const metadata: AssetMetadata = {
    name: kit.name, title: kit.title, description: kit.description,
    file: `examples/playground/assets/showcase/${kit.name}.glb`,
    sourceBytes: bytes.byteLength,
    uniqueTriangles: stats.uniqueTriangles,
    drawnTriangles: stats.drawnTriangles,
    originalUniqueTriangles: original.uniqueTriangles,
    originalPartCount: original.parts,
    meshCount: document.getRoot().listMeshes().length,
    primitiveCount: document.getRoot().listMeshes().reduce((sum, item) => sum + item.listPrimitives().length, 0),
    bounds: { min: bounds.min.toArray(), max: bounds.max.toArray() },
    size: bounds.max.clone().sub(bounds.min).toArray(),
    materials: kit.surfaces.map(surface => surface.material.name),
    animations: [...animations.keys()],
    textureSizes: Object.fromEntries([...textures.keys()].map(kind => [kind, images.get(kind)!.size])),
  };
  const geometries = new Set<BufferGeometry>();
  kit.root.traverse(object => { if (object instanceof Mesh) geometries.add(object.geometry); });
  for (const geometry of geometries) geometry.dispose();
  for (const surface of kit.surfaces) surface.material.dispose();
  return metadata;
}

if (await canReuse()) {
  console.log('Showcase: six original assets are up to date.');
} else {
  const started = performance.now();
  await mkdir(output, { recursive: true });
  const textureKinds: TextureKind[] = ['ceramic', 'wood', 'metal', 'bark', 'leaf', 'ground', 'coral', 'lens'];
  const images = new Map(await Promise.all(textureKinds.map(async kind => [kind, await generateTexture(kind)] as const)));
  const assets: AssetMetadata[] = [];
  for (const factory of [pavilion, reactor, canopy, terrain, coral, luminaire]) {
    const asset = await exportKit(factory(), images);
    assets.push(asset);
    console.log(`${asset.name}: ${asset.uniqueTriangles.toLocaleString('en-US')} unique triangles, ${asset.primitiveCount} primitives, ${(asset.sourceBytes / 1024 / 1024).toFixed(2)} MiB source, animations=${asset.animations.join(',') || 'none'}`);
  }
  const totalTriangles = assets.reduce((sum, asset) => sum + asset.originalUniqueTriangles, 0);
  const totalBytes = assets.reduce((sum, asset) => sum + asset.sourceBytes, 0);
  if (totalTriangles < 400_000 || totalBytes < 10 * 1024 * 1024) {
    throw new Error(`Showcase complexity contract not met: ${totalTriangles} original unique triangles, ${totalBytes} bytes`);
  }
  await writeIfChanged(metadataPath, `/** Generated by scripts/generate-showcase.ts from original procedural geometry. */\nexport const SHOWCASE_ASSETS = ${JSON.stringify(assets, null, 2)} as const;\n\nexport type ShowcaseAssetName = typeof SHOWCASE_ASSETS[number]['name'];\n`);
  await writeIfChanged(receiptPath, `${JSON.stringify({ fingerprint, assets }, null, 2)}\n`);
  console.log(`Showcase total: ${totalTriangles.toLocaleString('en-US')} original unique triangles, ${(totalBytes / 1024 / 1024).toFixed(2)} MiB source; generated in ${((performance.now() - started) / 1000).toFixed(1)} s.`);
}
