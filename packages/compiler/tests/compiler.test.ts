import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, KHRDracoMeshCompression } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import sharp from 'sharp';
import { compileAsset } from '../src/index.js';
import { makeFixture, writeFixture } from './fixtures.js';

const directories: string[] = [];
async function temporary(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'stream3d-compiler-'));
  directories.push(directory);
  return directory;
}
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

async function decoder(): Promise<NodeIO> {
  await MeshoptDecoder.ready;
  return new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
}

describe('compileAsset', () => {
  it('produces complete compressed LODs while preserving hierarchy, material, skin, morph and animation semantics', async () => {
    const directory = await temporary();
    const input = path.join(directory, 'character.glb');
    await writeFixture(input);
    const result = await compileAsset(input, { outDir: path.join(directory, 'output') });
    expect(result.cached).toBe(false);
    expect(result.manifest.levels.map((level) => level.id)).toEqual(['preview', 'standard', 'full']);
    expect(result.manifest.animations).toEqual(['Float']);
    expect(result.manifest.bounds.min[0]).toBeCloseTo(0);
    expect(result.manifest.bounds.max[0]).toBeCloseTo(2);
    const [preview, standard, full] = result.manifest.levels;
    expect(preview!.triangles).toBeLessThan(standard!.triangles);
    expect(standard!.triangles).toBeLessThan(full!.triangles);
    expect(preview!.byteLength).toBeLessThan(full!.byteLength);
    expect(preview!.estimatedGpuBytes).toBeLessThan(full!.estimatedGpuBytes);
    const io = await decoder();
    for (const level of result.manifest.levels) {
      const filename = path.join(path.dirname(result.manifestPath), level.url);
      const bytes = await readFile(filename);
      expect(bytes.byteLength).toBe(level.byteLength);
      const json = await io.binaryToJSON(bytes);
      expect(json.json.extensionsRequired).toContain('EXT_meshopt_compression');
      expect(json.json.extensionsRequired).toContain('EXT_texture_webp');
      expect(json.json.images?.every((image) => image.uri === undefined)).toBe(true);
      const root = (await io.readBinary(bytes)).getRoot();
      expect(root.listNodes().map((node) => node.getName())).toEqual(['Joint', 'Body']);
      const body = root.listNodes().find((node) => node.getName() === 'Body')!;
      expect(body.getTranslation()).toEqual([1, 0, 0]);
      expect(body.getSkin()?.listJoints().map((joint) => joint.getName())).toEqual(['Joint']);
      const primitive = body.getMesh()!.listPrimitives()[0]!;
      expect(primitive.getMaterial()?.getName()).toBe('Paint');
      expect(primitive.getAttribute('JOINTS_0')?.getCount()).toBe(primitive.getAttribute('POSITION')!.getCount());
      expect(primitive.listTargets()[0]!.getAttribute('POSITION')!.getCount()).toBe(primitive.getAttribute('POSITION')!.getCount());
      const channel = root.listAnimations()[0]!.listChannels()[0]!;
      expect(channel.getTargetNode()).toBe(body);
      expect(channel.getTargetPath()).toBe('translation');
      expect(Array.from(channel.getSampler()!.getOutput()!.getArray()!)).toEqual([1, 0, 0, 1, 0.5, 0, 1, 0, 0]);
      expect(root.listTextures()[0]!.getSize()![0]).toBeLessThanOrEqual(level.id === 'preview' ? 256 : 512);
    }
  });

  it('has deterministic identity and outputs, and verifies cached files before reuse', async () => {
    const directory = await temporary();
    const input = path.join(directory, 'asset.glb');
    await writeFixture(input);
    const first = await compileAsset(input, { outDir: path.join(directory, 'a') });
    const cached = await compileAsset(input, { outDir: path.join(directory, 'a') });
    const second = await compileAsset(input, { outDir: path.join(directory, 'b') });
    expect(cached.cached).toBe(true);
    expect(second.manifest).toEqual(first.manifest);
    await writeFile(first.files.find((file) => file.role === 'level')!.absolutePath, 'corrupted');
    const repaired = await compileAsset(input, { outDir: path.join(directory, 'a') });
    expect(repaired.cached).toBe(false);
    expect(repaired.manifest).toEqual(first.manifest);
  });

  it('tracks and hashes external texture dependencies, including unchanged glTF JSON', async () => {
    const directory = await temporary();
    const input = path.join(directory, 'asset.gltf');
    await writeFixture(input);
    const first = await compileAsset(input, { outDir: path.join(directory, 'output') });
    const sourceJSON = await readFile(input, 'utf8');
    expect(first.dependencies).toContain(path.join(directory, 'color.png'));
    expect(first.dependencies).toContain(path.join(directory, 'geometry.bin'));
    await sharp({ create: { width: 512, height: 512, channels: 3, background: '#cc3366' } }).png().toFile(path.join(directory, 'color.png'));
    const second = await compileAsset(input, { outDir: path.join(directory, 'output') });
    expect(await readFile(input, 'utf8')).toBe(sourceJSON);
    expect(second.manifest.id).not.toBe(first.manifest.id);
    expect(second.manifest.levels[0]!.url).not.toBe(first.manifest.levels[0]!.url);
  });

  it('accepts Draco input and emits Meshopt instead of requiring Draco in the browser', async () => {
    const directory = await temporary();
    const input = path.join(directory, 'draco.glb');
    const draco = await import('draco3dgltf');
    const document = await makeFixture();
    document.createExtension(KHRDracoMeshCompression).setRequired(true);
    const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'draco3d.encoder': await draco.default.createEncoderModule() });
    await io.write(input, document);
    const result = await compileAsset(input, { outDir: path.join(directory, 'output') });
    const json = await (await decoder()).binaryToJSON(await readFile(result.files.find((file) => file.role === 'level')!.absolutePath));
    expect(json.json.extensionsRequired).toContain('EXT_meshopt_compression');
    expect(json.json.extensionsUsed).not.toContain('KHR_draco_mesh_compression');
    expect(result.manifest.animations).toEqual(['Float']);
  });

  it('rejects unsupported extensions and invalid source data instead of dropping content', async () => {
    const directory = await temporary();
    const input = path.join(directory, 'bad.gltf');
    await writeFile(input, JSON.stringify({ asset: { version: '2.0' }, extensionsUsed: ['VENDOR_game_logic'] }));
    await expect(compileAsset(input, { outDir: directory })).rejects.toThrow('Unsupported extension VENDOR_game_logic');
    await writeFile(input, JSON.stringify({ asset: { version: '2.0' }, images: [{ uri: 'https://example.com/texture.png' }] }));
    await expect(compileAsset(input, { outDir: directory })).rejects.toThrow('portable relative file URI');
    await writeFile(path.join(directory, 'bad.glb'), 'not a GLB');
    await expect(compileAsset(path.join(directory, 'bad.glb'), { outDir: directory })).rejects.toThrow('Invalid GLB header');
  });

  it('rejects ambiguous level policies before compiling', async () => {
    await expect(compileAsset('absent.glb', { outDir: '/tmp/unused', levels: [{ id: 'only', ratio: 0, textureSize: 256, minScreenCoverage: 0 }] })).rejects.toThrow('ratio');
    await expect(compileAsset('absent.glb', { outDir: '/tmp/unused', levels: [{ id: 'only', ratio: 1, textureSize: 256, minScreenCoverage: 0.5 }] })).rejects.toThrow('initial level');
  });

  it('assigns stable names to unnamed animated nodes across independently decoded LODs', async () => {
    const directory = await temporary();
    const input = path.join(directory, 'unnamed.glb');
    const document = await makeFixture();
    document.getRoot().listNodes().forEach((node) => node.setName(''));
    await new NodeIO().write(input, document);
    const result = await compileAsset(input, { outDir: path.join(directory, 'out') });
    const io = await decoder();
    let targetName: string | undefined;
    for (const level of result.manifest.levels) {
      const root = (await io.read(path.join(path.dirname(result.manifestPath), level.url))).getRoot();
      const target = root.listAnimations()[0]!.listChannels()[0]!.getTargetNode()!.getName();
      expect(target).toMatch(/^__stream3d_node_/);
      targetName ??= target;
      expect(target).toBe(targetName);
    }
  });

  it('keeps each caller\'s dependency paths when identical inputs share an in-flight compile', async () => {
    const directory = await temporary();
    await Promise.all(['a', 'b'].map((name) => mkdir(path.join(directory, name))));
    const firstPath = path.join(directory, 'a', 'source.glb');
    const secondPath = path.join(directory, 'b', 'source.glb');
    await writeFixture(firstPath);
    await copyFile(firstPath, secondPath);
    const [first, second] = await Promise.all([firstPath, secondPath].map((filename) => compileAsset(filename, { outDir: path.join(directory, 'out') })));
    expect(first.manifest.id).toBe(second.manifest.id);
    expect(first.dependencies).toEqual([firstPath]);
    expect(second.dependencies).toEqual([secondPath]);
  });

  it('rejects ambiguous clip names and extensions that the browser loader cannot reproduce', async () => {
    const directory = await temporary();
    const input = path.join(directory, 'duplicate.glb');
    const document = await makeFixture();
    document.createAnimation('Float');
    await new NodeIO().write(input, document);
    await expect(compileAsset(input, { outDir: directory })).rejects.toThrow('duplicated');
    const invalid = path.join(directory, 'variants.gltf');
    await writeFile(invalid, JSON.stringify({ asset: { version: '2.0' }, extensionsUsed: ['KHR_materials_variants'] }));
    await expect(compileAsset(invalid, { outDir: directory })).rejects.toThrow('Unsupported runtime extension KHR_materials_variants');
  });
});
