import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { build, createServer, type ViteDevServer } from 'vite';
import { stream3d } from '../src/index.js';
import { writeFixture } from '../../compiler/tests/fixtures.js';
import type { AssetManifest } from '@stream3d/core';

const directories: string[] = [];
const servers: ViteDevServer[] = [];
async function project(extension: 'glb' | 'gltf' = 'glb'): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'stream3d-vite-'));
  directories.push(directory);
  await writeFixture(path.join(directory, `source.${extension}`));
  await writeFile(path.join(directory, 'index.html'), '<!doctype html><script type="module" src="/main.ts"></script>');
  await writeFile(path.join(directory, 'main.ts'), `import asset, {manifestUrl} from './source.${extension}?asset'; globalThis.stream3dTest = {asset, manifestUrl};`);
  return directory;
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('Vite asset integration', () => {
  for (const base of ['/gallery/', 'https://cdn.example.test/app/', './']) {
    it(`emits self-contained assets and resolves production URLs for base ${base}`, async () => {
      const root = await project();
      await build({
        configFile: false,
        root,
        base,
        plugins: [stream3d()],
        logLevel: 'silent',
        build: { outDir: 'dist', minify: false, modulePreload: { polyfill: false } },
      });
      const output = path.join(root, 'dist');
      const files = await readdir(output, { recursive: true });
      const manifestFile = files.find((file) => file.endsWith('.stream3d.json'))!;
      const manifestPath = path.join(output, manifestFile);
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as AssetManifest;
      expect(manifest.levels).toHaveLength(3);
      for (const level of manifest.levels) {
        expect((await readFile(path.join(path.dirname(manifestPath), level.url))).byteLength).toBe(level.byteLength);
      }
      const js = await readFile(path.join(output, files.find((file) => file.endsWith('.js'))!), 'utf8');
      expect(js).not.toContain('ROLLUP_FILE_URL');
      // Unminified Vite output includes source-location comments, unrelated to runtime URLs.
      expect(js.replace(/^\s*\/\/.*$/gm, '')).not.toContain(root);
      expect(js).not.toContain('__stream3d/assets/');
      if (base === './') {
        expect(js).toMatch(/new URL\(["'](?:\.\/)?stream3d\//);
        expect(js).toContain('import.meta.url');
      } else {
        expect(js).toContain(`${base}assets/stream3d/`);
      }
    });
  }

  it('serves only registered compiled files in dev and watches glTF external dependencies', async () => {
    const root = await project('gltf');
    const server = await createServer({ configFile: false, root, base: '/app/', plugins: [stream3d()], logLevel: 'silent', server: { host: '127.0.0.1', port: 0, hmr: false } });
    servers.push(server);
    await server.listen();
    const resolved = await server.pluginContainer.resolveId('./source.gltf?asset', path.join(root, 'main.ts'));
    expect(resolved).not.toBeNull();
    const loaded = await server.pluginContainer.load(resolved!.id);
    const code = typeof loaded === 'string' ? loaded : loaded!.code;
    const match = code.match(/export default (.+);/);
    const manifest = JSON.parse(match![1]!) as AssetManifest;
    const address = server.httpServer!.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP listener.');
    const origin = `http://127.0.0.1:${address.port}`;
    const response = await fetch(origin + manifest.levels[0]!.url);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('model/gltf-binary');
    expect((await response.arrayBuffer()).byteLength).toBe(manifest.levels[0]!.byteLength);
    expect((await fetch(`${origin}/app/__stream3d/assets/package.json`)).status).toBe(404);
    expect((await fetch(`${origin}/app/__stream3d/assets/unknown.glb`)).status).toBe(404);
    const watched = server.watcher.getWatched();
    expect(watched[root]).toEqual(expect.arrayContaining(['source.gltf', 'color.png', 'geometry.bin']));
  });
});
