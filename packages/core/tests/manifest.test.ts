import { describe, expect, it } from 'vitest';
import { defineAsset, resolveAssetUrl, validateManifest, type AssetManifest } from '../src/index.js';

function manifest(): AssetManifest {
  return {
    format: 'stream3d', version: 1, id: 'content-hash', name: 'Example',
    bounds: { min: [-1, -1, -1], max: [1, 1, 1] }, animations: ['Idle'],
    levels: [
      { id: 'coarse', url: './coarse.glb', byteLength: 100, estimatedGpuBytes: 300, triangles: 20, minScreenCoverage: 0 },
      { id: 'fine', url: './fine.glb', byteLength: 200, estimatedGpuBytes: 500, triangles: 100, minScreenCoverage: 0.3 },
    ],
  };
}

describe('manifest contracts', () => {
  it('validates and detaches a manifest from mutable input JSON', () => {
    const input = manifest();
    const result = validateManifest(input);
    expect(result).toEqual(input);
    input.bounds.min[0] = -20;
    input.levels[0]!.url = 'changed';
    expect(result.bounds.min[0]).toBe(-1);
    expect(result.levels[0]!.url).toBe('./coarse.glb');
    expect(defineAsset(manifest())).toEqual(manifest());
  });

  it.each([
    ['format', { format: 'other' }],
    ['version', { version: 2 }],
    ['id', { id: '' }],
    ['name', { name: ' ' }],
    ['bounds', { bounds: { min: [1, 0, 0], max: [0, 0, 0] } }],
    ['bounds.min', { bounds: { min: [Infinity, 0, 0], max: [1, 1, 1] } }],
    ['bounds.min', { bounds: { min: new Array(3), max: [1, 1, 1] } }],
    ['levels', { levels: [] }],
    ['levels[0]', { levels: new Array(1) }],
    ['animations', { animations: null }],
    ['animations[0]', { animations: [4] }],
  ])('rejects malformed %s with location context', (path, patch) => {
    expect(() => validateManifest({ ...manifest(), ...patch })).toThrow(String(path));
  });

  it('rejects duplicate levels, inverted detail order and invalid sizes', () => {
    const duplicate = manifest();
    duplicate.levels[1]!.id = 'coarse';
    expect(() => validateManifest(duplicate)).toThrow('duplicate');
    const inverted = manifest();
    inverted.levels[0]!.minScreenCoverage = 0.9;
    expect(() => validateManifest(inverted)).toThrow('ordered');
    const invalidSize = manifest();
    invalidSize.levels[0]!.estimatedGpuBytes = -1;
    expect(() => validateManifest(invalidSize)).toThrow('estimatedGpuBytes');
    const invalidCoverage = manifest();
    invalidCoverage.levels[0]!.minScreenCoverage = 1.1;
    expect(() => validateManifest(invalidCoverage)).toThrow('minScreenCoverage');
  });

  it('resolves URLs from the manifest location, not the document location', () => {
    expect(resolveAssetUrl('../levels/coarse.glb', 'https://cdn.example.test/a/asset/manifest.json?token=1'))
      .toBe('https://cdn.example.test/a/levels/coarse.glb');
    expect(resolveAssetUrl('https://other.example.test/fine.glb?v=2', 'https://cdn.example.test/manifest.json'))
      .toBe('https://other.example.test/fine.glb?v=2');
    expect(() => resolveAssetUrl('coarse.glb', 'not-absolute')).toThrow('Cannot resolve');
  });
});
