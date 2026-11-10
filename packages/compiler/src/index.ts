import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Document, GLB_BUFFER, Logger, NodeIO, Primitive, type GLTF, type JSONDocument } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshoptCompression, EXTTextureWebP } from '@gltf-transform/extensions';
import { cloneDocument, compressTexture, getBounds, listTextureSlots, reorder, simplifyPrimitive, unpartition, weldPrimitive } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';
import { validateManifest, type AssetBounds, type AssetLevel, type AssetManifest, type Vec3 } from '@stream3d/core';

/** Compilation policy, ordered from the smallest initial representation to the highest detail. */
export interface CompileLevelOptions {
  id: string;
  /** Target proportion of triangles. Topology and the error limit may prevent reaching it. */
  ratio: number;
  /** Maximum texture edge length. Aspect ratios are preserved; images are never enlarged. */
  textureSize: number;
  minScreenCoverage: number;
}

export interface CompileOptions {
  outDir: string;
  levels?: readonly CompileLevelOptions[];
}

export interface CompiledFile {
  /** A portable filename, relative to outDir. Output GLBs contain all their dependencies. */
  fileName: string;
  absolutePath: string;
  mimeType: 'model/gltf-binary' | 'application/json';
  byteLength: number;
  role: 'level' | 'manifest';
}

export interface CompileResult {
  /** URLs are relative to manifestPath. Vite replaces these with deployment URLs. */
  manifest: AssetManifest;
  manifestPath: string;
  files: CompiledFile[];
  /** Source and all local external buffers/images, for build watch invalidation. */
  dependencies: string[];
  cached: boolean;
}

export const DEFAULT_LEVELS: readonly CompileLevelOptions[] = Object.freeze([
  Object.freeze({ id: 'preview', ratio: 0.15, textureSize: 256, minScreenCoverage: 0 }),
  Object.freeze({ id: 'standard', ratio: 0.45, textureSize: 512, minScreenCoverage: 0.25 }),
  Object.freeze({ id: 'full', ratio: 1, textureSize: 1024, minScreenCoverage: 0.65 }),
]);

// Change this whenever output semantics change, including changes to the pinned encoder versions.
const PIPELINE_VERSION = 'stream3d-0.1.0-pipeline-2:gltf-transform-4.5.1:meshoptimizer-1.3.0';
/** Extensions preserved end-to-end by both the compiler and the bundled browser loader. */
export const SUPPORTED_INPUT_EXTENSIONS: readonly string[] = Object.freeze([
  'KHR_draco_mesh_compression', 'KHR_lights_punctual',
  'KHR_materials_anisotropy', 'KHR_materials_clearcoat', 'KHR_materials_dispersion',
  'KHR_materials_emissive_strength', 'KHR_materials_ior', 'KHR_materials_iridescence',
  'KHR_materials_sheen', 'KHR_materials_specular', 'KHR_materials_transmission',
  'KHR_materials_unlit', 'KHR_materials_volume', 'KHR_mesh_quantization',
  'KHR_texture_transform', 'EXT_meshopt_compression', 'EXT_texture_webp',
]);
const inflight = new Map<string, Promise<CompileResult>>();
const logger = new Logger(Logger.Verbosity.ERROR);
let dracoDecoder: Promise<unknown> | undefined;

/**
 * Compile a local glTF 2.0 asset into independent, complete coarse-to-fine GLBs.
 * Node/material names, graph structure, animation channels and skin bindings are retained.
 * Bounds describe the default scene's authored rest pose, not its animated motion envelope.
 * WebP textures decode to ordinary GPU textures; this compiler does not claim KTX2 support.
 */
export async function compileAsset(inputPath: string, options: CompileOptions): Promise<CompileResult> {
  const source = path.resolve(inputPath);
  const outDir = path.resolve(options.outDir);
  const levels = validateLevels(options.levels ?? DEFAULT_LEVELS);
  if (!/\.(glb|gltf)$/i.test(source)) {
    throw new Error(`Stream3D compiler: expected a .glb or .gltf file, received ${path.basename(source)}.`);
  }
  try {
    const snapshot = await readSnapshot(source);
    const name = path.basename(source, path.extname(source));
    const digest = createHash('sha256')
      .update(PIPELINE_VERSION)
      .update(JSON.stringify(sharp.versions))
      .update(JSON.stringify({ name, levels }))
      .update(snapshot.digest)
      .digest('hex');
    const id = `asset-${digest}`;
    const key = `${outDir}\0${id}`;
    const pending = inflight.get(key);
    if (pending) return { ...await pending, dependencies: snapshot.dependencies };
    const work = compileSnapshot(snapshot, { outDir, levels, id, name });
    inflight.set(key, work);
    try {
      return await work;
    } finally {
      if (inflight.get(key) === work) inflight.delete(key);
    }
  } catch (error) {
    throw new Error(`Stream3D could not compile ${source}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

interface Snapshot {
  document: JSONDocument;
  digest: string;
  dependencies: string[];
}

async function readSnapshot(source: string): Promise<Snapshot> {
  const sourceBytes = await readFile(source);
  const document = path.extname(source).toLowerCase() === '.glb'
    ? unpackGLB(sourceBytes)
    : { json: JSON.parse(sourceBytes.toString('utf8')) as GLTF.IGLTF, resources: {} } satisfies JSONDocument;
  if (!document.json || document.json.asset?.version !== '2.0') {
    throw new Error('Only glTF 2.0 assets are supported. Re-export the asset as glTF 2.0.');
  }
  const knownExtensions = new Set(ALL_EXTENSIONS.map((extension) => extension.EXTENSION_NAME));
  for (const name of document.json.extensionsUsed ?? []) {
    if (!knownExtensions.has(name)) {
      throw new Error(`Unsupported extension ${name}. Export a version without this extension; it will not be silently removed.`);
    }
    if (name === 'KHR_mesh_primitive_restart') {
      throw new Error('KHR_mesh_primitive_restart is not supported by the simplifier. Export ordinary triangle primitives.');
    }
    if (!SUPPORTED_INPUT_EXTENSIONS.includes(name)) {
      throw new Error(`Unsupported runtime extension ${name}. Export an asset without this extension; accepting a compiler extension that the browser cannot render would lose content. For KTX2/AVIF textures, export PNG/JPEG/WebP source textures.`);
    }
  }
  for (const name of document.json.extensionsRequired ?? []) {
    if (!(document.json.extensionsUsed ?? []).includes(name)) {
      throw new Error(`Invalid glTF: required extension ${name} is missing from extensionsUsed.`);
    }
  }
  assertDeclaredExtensions(document.json, new Set(document.json.extensionsUsed ?? []));
  const uris = [...new Set([
    ...(document.json.buffers ?? []).map((buffer) => buffer.uri),
    ...(document.json.images ?? []).map((image) => image.uri),
  ].filter((uri): uri is string => typeof uri === 'string' && !uri.startsWith('data:')))].sort();
  const dependencies = [source];
  const hash = createHash('sha256').update(sourceBytes);
  // Read each dependency once, then compile exactly those bytes. Changes in external images or
  // buffers therefore invalidate the cache even when the .gltf JSON itself is unchanged.
  for (const uri of uris) {
    if (/^[a-z][a-z\d+.-]*:/i.test(uri) || uri.startsWith('/') || uri.includes('\\') || /[?#]/.test(uri)) {
      throw new Error(`External resource ${JSON.stringify(uri)} must be a portable relative file URI. Download it alongside the glTF first.`);
    }
    const dependencyPath = path.resolve(path.dirname(source), decodeURIComponent(uri));
    let bytes: Buffer<ArrayBuffer>;
    try {
      bytes = await readFile(dependencyPath);
    } catch (error) {
      throw new Error(`Missing or unreadable glTF dependency ${JSON.stringify(uri)} (${dependencyPath}).`, { cause: error });
    }
    document.resources[uri] = bytes;
    dependencies.push(dependencyPath);
    hash.update(JSON.stringify([uri, bytes.byteLength])).update(bytes);
  }
  return { document, digest: hash.digest('hex'), dependencies: [...new Set(dependencies)] };
}

function assertDeclaredExtensions(value: unknown, declared: Set<string>): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) { value.forEach((entry) => assertDeclaredExtensions(entry, declared)); return; }
  for (const [key, child] of Object.entries(value)) {
    if (key === 'extras') continue;
    if (key === 'extensions' && child && typeof child === 'object') {
      for (const name of Object.keys(child)) if (!declared.has(name)) throw new Error(`Invalid glTF: extension ${name} is used but missing from extensionsUsed.`);
    }
    assertDeclaredExtensions(child, declared);
  }
}

/** Only container framing is inspected here; all scene parsing and mesh codecs use glTF Transform. */
function unpackGLB(bytes: Buffer<ArrayBuffer>): JSONDocument {
  if (bytes.byteLength < 20 || bytes.readUInt32LE(0) !== 0x46546c67 || bytes.readUInt32LE(4) !== 2) {
    throw new Error('Invalid GLB header. Export a valid binary glTF 2.0 file.');
  }
  if (bytes.readUInt32LE(8) !== bytes.byteLength) throw new Error('GLB length does not match its header; the file may be truncated.');
  const jsonLength = bytes.readUInt32LE(12);
  if (bytes.readUInt32LE(16) !== 0x4e4f534a || jsonLength % 4 || 20 + jsonLength > bytes.byteLength) {
    throw new Error('Invalid or missing GLB JSON chunk.');
  }
  const json = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString('utf8')) as GLTF.IGLTF;
  const resources: JSONDocument['resources'] = {};
  let offset = 20 + jsonLength;
  while (offset < bytes.byteLength) {
    if (offset + 8 > bytes.byteLength) throw new Error('Truncated GLB chunk header.');
    const length = bytes.readUInt32LE(offset);
    const type = bytes.readUInt32LE(offset + 4);
    if (length % 4 || offset + 8 + length > bytes.byteLength) throw new Error('Truncated or unaligned GLB chunk.');
    if (type === 0x004e4942) {
      if (resources[GLB_BUFFER]) throw new Error('Invalid GLB: multiple binary chunks.');
      resources[GLB_BUFFER] = bytes.subarray(offset + 8, offset + 8 + length);
    }
    offset += 8 + length;
  }
  return { json, resources };
}

function validateLevels(input: readonly CompileLevelOptions[]): CompileLevelOptions[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > 8) throw new Error('Specify between 1 and 8 compilation levels.');
  const seen = new Set<string>();
  const result = input.map((level) => ({ ...level }));
  result.forEach((level, index) => {
    if (!/^[a-z][a-z\d_-]*$/i.test(level.id) || seen.has(level.id)) throw new Error('Level IDs must be unique simple identifiers.');
    seen.add(level.id);
    if (!Number.isFinite(level.ratio) || level.ratio <= 0 || level.ratio > 1) throw new Error(`Level ${level.id}: ratio must be greater than 0 and at most 1.`);
    if (!Number.isInteger(level.textureSize) || level.textureSize < 16 || level.textureSize > 8192) throw new Error(`Level ${level.id}: textureSize must be an integer between 16 and 8192.`);
    if (!Number.isFinite(level.minScreenCoverage) || level.minScreenCoverage < 0 || level.minScreenCoverage > 1) throw new Error(`Level ${level.id}: minScreenCoverage must be between 0 and 1.`);
    if (index === 0 && level.minScreenCoverage !== 0) throw new Error('The initial level must have minScreenCoverage: 0.');
    const previous = result[index - 1];
    if (previous && (level.ratio < previous.ratio || level.textureSize < previous.textureSize || level.minScreenCoverage <= previous.minScreenCoverage)) {
      throw new Error('Levels must be ordered coarse-to-fine, with increasing screen coverage thresholds.');
    }
  });
  return result;
}

async function createIO(extensions: readonly string[]): Promise<NodeIO> {
  await Promise.all([MeshoptEncoder.ready, MeshoptDecoder.ready, MeshoptSimplifier.ready]);
  const dependencies: Record<string, unknown> = { 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder };
  if (extensions.includes('KHR_draco_mesh_compression')) {
    dracoDecoder ??= import('draco3dgltf').then((module) => module.default.createDecoderModule());
    dependencies['draco3d.decoder'] = await dracoDecoder;
  }
  return new NodeIO().setLogger(logger).registerExtensions(ALL_EXTENSIONS).registerDependencies(dependencies);
}

async function compileSnapshot(snapshot: Snapshot, options: { outDir: string; levels: CompileLevelOptions[]; id: string; name: string }): Promise<CompileResult> {
  const { outDir, id, name, levels } = options;
  await mkdir(outDir, { recursive: true });
  const manifestPath = path.join(outDir, `${id}.stream3d.json`);
  const cached = await readCache(manifestPath, id, snapshot.dependencies);
  if (cached) return cached;
  const io = await createIO(snapshot.document.json.extensionsUsed ?? []);
  const sourceDocument = await io.readJSON(snapshot.document);
  validateDocument(sourceDocument);
  assignStableNames(sourceDocument);
  // Decode Draco on input, then emit only Meshopt. Never keep an encoder extension without its encoder.
  for (const extension of sourceDocument.getRoot().listExtensionsUsed()) {
    if (extension.extensionName === 'KHR_draco_mesh_compression' || extension.extensionName === 'EXT_meshopt_compression') extension.dispose();
  }
  const bounds = computeBounds(sourceDocument);
  const semanticSignature = structureSignature(sourceDocument);
  const outputs: CompiledFile[] = [];
  const manifestLevels: AssetLevel[] = [];
  for (const level of levels) {
    const document = cloneDocument(sourceDocument);
    const root = document.getRoot();
    for (const mesh of root.listMeshes()) {
      for (const primitive of mesh.listPrimitives()) {
        weldPrimitive(primitive, { overwrite: false });
        const count = primitive.getIndices()?.getCount() ?? primitive.getAttribute('POSITION')!.getCount();
        // Keep small meshes intact; reducing a tiny primitive can remove a meaningful object.
        if (level.ratio < 1 && count >= 96 && primitive.getMode() === Primitive.Mode.TRIANGLES) {
          simplifyPrimitive(primitive, { simplifier: MeshoptSimplifier, ratio: Math.max(level.ratio, 12 / count), error: 0.02 });
          if (!primitive.getIndices()?.getCount()) throw new Error(`Simplification removed all geometry in mesh ${JSON.stringify(mesh.getName())}. Use a less aggressive level ratio.`);
        }
      }
    }
    for (const texture of root.listTextures()) {
      const slots = listTextureSlots(texture);
      // Data maps need lossless channel encoding. Resampling remains intentionally lossy per LOD.
      const colorOnly = slots.length > 0 && slots.every((slot) => /^(baseColorTexture|emissiveTexture|diffuseTexture)$/.test(slot));
      await compressTexture(texture, { encoder: sharp, targetFormat: 'webp', resize: [level.textureSize, level.textureSize], quality: 85, effort: 30, lossless: !colorOnly });
    }
    if (root.listTextures().length) document.createExtension(EXTTextureWebP).setRequired(true);
    await document.transform(reorder({ encoder: MeshoptEncoder, target: 'size' }), unpartition());
    // Lossless mesh buffer encoding preserves local transforms across LODs. Quantization that
    // inserts compensation transforms would complicate stable object handles and animation state.
    document.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
    if (structureSignature(document) !== semanticSignature) throw new Error('Optimization changed scene or animation structure; refusing to emit a broken progressive asset.');
    const stats = resourceStats(document);
    const bytes = await io.writeBinary(document);
    const fileName = `level-${sha256(bytes)}.glb`;
    const absolutePath = path.join(outDir, fileName);
    await atomicWrite(absolutePath, bytes);
    if (!outputs.some((file) => file.fileName === fileName)) outputs.push({ fileName, absolutePath, mimeType: 'model/gltf-binary', byteLength: bytes.byteLength, role: 'level' });
    manifestLevels.push({ id: level.id, url: fileName, byteLength: bytes.byteLength, ...stats, minScreenCoverage: level.minScreenCoverage });
  }
  const manifest: AssetManifest = {
    format: 'stream3d', version: 1, id, name, bounds,
    animations: sourceDocument.getRoot().listAnimations().map((animation, index) => animation.getName() || `animation_${index}`),
    levels: manifestLevels,
  };
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  // Publish the manifest last, after every dependency is available.
  await atomicWrite(manifestPath, bytes);
  outputs.push({ fileName: path.basename(manifestPath), absolutePath: manifestPath, mimeType: 'application/json', byteLength: bytes.byteLength, role: 'manifest' });
  return { manifest, manifestPath, files: outputs, dependencies: snapshot.dependencies, cached: false };
}

function validateDocument(document: Document): void {
  const root = document.getRoot();
  if (!root.listScenes().length || !root.listMeshes().length) throw new Error('The asset must contain a scene with renderable triangle meshes.');
  for (const mesh of root.listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      if (primitive.getMode() !== Primitive.Mode.TRIANGLES) throw new Error(`Mesh ${JSON.stringify(mesh.getName())} uses a non-triangle draw mode. Triangulate the mesh before exporting.`);
      const position = primitive.getAttribute('POSITION');
      if (!position?.getArray() || position.getCount() < 3) throw new Error(`Mesh ${JSON.stringify(mesh.getName())} has missing or empty POSITION data.`);
      if (!Array.from(position.getArray()!).every(Number.isFinite)) throw new Error(`Mesh ${JSON.stringify(mesh.getName())} contains non-finite positions.`);
      const count = primitive.getIndices()?.getCount() ?? position.getCount();
      if (count % 3) throw new Error(`Mesh ${JSON.stringify(mesh.getName())} has an invalid triangle index count.`);
      const indices = primitive.getIndices()?.getArray();
      if (indices && Array.from(indices).some((index) => index < 0 || index >= position.getCount())) throw new Error(`Mesh ${JSON.stringify(mesh.getName())} has an out-of-range vertex index.`);
    }
  }
  for (const texture of root.listTextures()) {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(texture.getMimeType()) || !texture.getImage()) {
      throw new Error(`Texture ${JSON.stringify(texture.getName() || texture.getURI())} uses ${texture.getMimeType() || 'an unknown format'}. This compiler resizes PNG/JPEG/WebP textures; export an uncompressed source texture instead of KTX2/AVIF.`);
    }
  }
}

function computeBounds(document: Document): AssetBounds {
  const root = document.getRoot();
  const scene = root.getDefaultScene() ?? root.listScenes()[0]!;
  const bounds = getBounds(scene);
  if (![...bounds.min, ...bounds.max].every(Number.isFinite)) throw new Error('The default scene has no finite mesh bounds. Attach its meshes to the scene before exporting.');
  return { min: [...bounds.min] as Vec3, max: [...bounds.max] as Vec3 };
}

function assignStableNames(document: Document): void {
  const root = document.getRoot();
  const nodeNames = new Set(root.listNodes().map((node) => node.getName()).filter(Boolean));
  root.listNodes().forEach((node, index) => {
    if (node.getName()) return;
    let name = `__stream3d_node_${index}`;
    while (nodeNames.has(name)) name += '_';
    node.setName(name);
    nodeNames.add(name);
  });
  // GLTFLoader otherwise binds unnamed animated nodes by UUID, which changes when cloning.
  // Existing authored node/material names remain unchanged.
  const animationNames = new Set<string>();
  for (const animation of root.listAnimations()) {
    const name = animation.getName();
    if (name && animationNames.has(name)) throw new Error(`Animation name ${JSON.stringify(name)} is duplicated. Give each clip a unique name so play(name) can address it unambiguously.`);
    if (name) animationNames.add(name);
  }
  root.listAnimations().forEach((animation, index) => {
    if (animation.getName()) return;
    let name = `animation_${index}`;
    while (animationNames.has(name)) name += '_';
    animation.setName(name);
    animationNames.add(name);
  });
}

function structureSignature(document: Document): string {
  const root = document.getRoot();
  const nodes = root.listNodes();
  return JSON.stringify({
    nodes: nodes.map((node) => ({ name: node.getName(), translation: node.getTranslation(), rotation: node.getRotation(), scale: node.getScale(), children: node.listChildren().map((child) => nodes.indexOf(child)), weights: node.getWeights() })),
    materials: root.listMaterials().map((material) => material.getName()),
    skins: root.listSkins().map((skin) => ({ name: skin.getName(), joints: skin.listJoints().map((joint) => nodes.indexOf(joint)), skeleton: skin.getSkeleton() ? nodes.indexOf(skin.getSkeleton()!) : null })),
    animations: root.listAnimations().map((animation) => ({ name: animation.getName(), channels: animation.listChannels().map((channel) => ({ path: channel.getTargetPath(), node: channel.getTargetNode() ? nodes.indexOf(channel.getTargetNode()!) : null, interpolation: channel.getSampler()?.getInterpolation(), input: channel.getSampler()?.getInput()?.getCount(), output: channel.getSampler()?.getOutput()?.getCount() })) })),
  });
}

function resourceStats(document: Document): Pick<AssetLevel, 'triangles' | 'estimatedGpuBytes'> {
  const root = document.getRoot();
  let triangles = 0;
  for (const mesh of root.listMeshes()) for (const primitive of mesh.listPrimitives()) triangles += (primitive.getIndices()?.getCount() ?? primitive.getAttribute('POSITION')!.getCount()) / 3;
  // Conservative resource estimate: decoded accessors plus RGBA8 textures with a full mip chain.
  // It intentionally does not equate compressed transfer bytes with GPU residency.
  let estimatedGpuBytes = root.listAccessors().reduce((sum, accessor) => sum + (accessor.getArray()?.byteLength ?? 0), 0);
  for (const texture of root.listTextures()) {
    const size = texture.getSize();
    if (!size) throw new Error(`Cannot determine dimensions of texture ${JSON.stringify(texture.getName())}.`);
    estimatedGpuBytes += Math.ceil(size[0] * size[1] * 4 * 4 / 3);
  }
  return { triangles, estimatedGpuBytes };
}

async function readCache(manifestPath: string, id: string, dependencies: string[]): Promise<CompileResult | null> {
  try {
    const manifestBytes = await readFile(manifestPath);
    const manifest = validateManifest(JSON.parse(manifestBytes.toString('utf8')));
    if (manifest.format !== 'stream3d' || manifest.version !== 1 || manifest.id !== id || !Array.isArray(manifest.levels) || !manifest.levels.length) return null;
    const files: CompiledFile[] = [];
    for (const level of manifest.levels) {
      if (!/^level-[a-f0-9]{64}\.glb$/.test(level.url)) return null;
      if (files.some((file) => file.fileName === level.url)) continue;
      const absolutePath = path.join(path.dirname(manifestPath), level.url);
      const bytes = await readFile(absolutePath);
      if (bytes.byteLength !== level.byteLength || level.url !== `level-${sha256(bytes)}.glb`) return null;
      files.push({ fileName: level.url, absolutePath, mimeType: 'model/gltf-binary', byteLength: bytes.byteLength, role: 'level' });
    }
    files.push({ fileName: path.basename(manifestPath), absolutePath: manifestPath, mimeType: 'application/json', byteLength: manifestBytes.byteLength, role: 'manifest' });
    return { manifest, manifestPath, files, dependencies, cached: true };
  } catch {
    return null;
  }
}

function sha256(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }

async function atomicWrite(destination: string, bytes: Uint8Array): Promise<void> {
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, bytes);
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}
