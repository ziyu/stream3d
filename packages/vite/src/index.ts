import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { compileAsset, type CompileLevelOptions, type CompiledFile, type CompileResult } from '@stream3d/compiler';
import { isFileLoadingAllowed, type Plugin, type ResolvedConfig, type ViteDevServer } from 'vite';

export interface Stream3DPluginOptions {
  /** Overrides the compiler's default preview/standard/full policies. */
  levels?: readonly CompileLevelOptions[];
}

const VIRTUAL_PREFIX = '\0stream3d:asset:';
const ASSET_ROUTE = '__stream3d/assets/';

/**
 * `import model from './model.glb?asset'` compiles progressive assets automatically.
 * Dev serves only registered compiled outputs. Production assets are emitted through the bundler,
 * with URLs respecting absolute, CDN and relative Vite bases.
 */
export function stream3d(options: Stream3DPluginOptions = {}): Plugin {
  let config: ResolvedConfig;
  let devServer: ViteDevServer | undefined;
  const dependenciesByModule = new Map<string, Set<string>>();
  const sourcesByModule = new Map<string, string>();
  const servedFiles = new Map<string, CompiledFile>();
  const emittedFiles = new Map<string, string>();
  const ownReferences = new Set<string>();

  return {
    name: 'stream3d',
    enforce: 'pre',

    configResolved(resolved) { config = resolved; },

    buildStart() {
      emittedFiles.clear();
      ownReferences.clear();
    },

    async resolveId(source, importer) {
      if (sourcesByModule.has(source)) return source;
      const queryStart = source.indexOf('?');
      if (queryStart < 0 || !/\.(glb|gltf)$/i.test(source.slice(0, queryStart))) return;
      const query = new URLSearchParams(source.slice(queryStart + 1));
      if (!query.has('asset')) return;
      if ([...query.keys()].some((key) => key !== 'asset')) this.error('Stream3D ?asset imports cannot be combined with ?url, ?raw or other import modifiers.');
      const filename = source.slice(0, queryStart);
      const resolved = await this.resolve(filename, importer, { skipSelf: true });
      if (!resolved || resolved.external || !path.isAbsolute(resolved.id)) {
        this.error(`Stream3D could not resolve local asset ${JSON.stringify(filename)} from ${JSON.stringify(importer)}.`);
      }
      if (config.command === 'serve' && !isFileLoadingAllowed(config, resolved.id)) this.error(`Stream3D asset is outside Vite's allowed source directories: ${filename}`);
      const virtualId = `${VIRTUAL_PREFIX}${createHash('sha256').update(resolved.id).digest('hex')}`;
      sourcesByModule.set(virtualId, resolved.id);
      return virtualId;
    },

    async load(id) {
      if (!id.startsWith(VIRTUAL_PREFIX)) return;
      const source = sourcesByModule.get(id);
      if (!source) return;
      const result = await compileAsset(source, {
        outDir: path.join(config.cacheDir, 'stream3d'),
        levels: options.levels,
      });
      const dependencies = new Set(result.dependencies.map((file) => path.resolve(file)));
      if (config.command === 'serve') {
        for (const dependency of dependencies) if (!isFileLoadingAllowed(config, dependency)) this.error(`Stream3D dependency is outside Vite's allowed source directories: ${dependency}`);
      }
      dependenciesByModule.set(id, dependencies);
      for (const dependency of dependencies) this.addWatchFile(dependency);
      devServer?.watcher.add([...dependencies]);

      if (config.command === 'serve') {
        for (const file of result.files) servedFiles.set(file.fileName, file);
        const prefix = `${devBase(config.base)}${ASSET_ROUTE}`;
        const manifest = { ...result.manifest, levels: result.manifest.levels.map((level) => ({ ...level, url: `${prefix}${level.url}` })) };
        return `export const manifestUrl = ${JSON.stringify(prefix + path.basename(result.manifestPath))};\nexport default ${JSON.stringify(manifest)};\n`;
      }

      const contents = await Promise.all(result.files.map(async (file) => ({ file, bytes: await readFile(file.absolutePath) })));
      for (const { file, bytes } of contents) {
        if (emittedFiles.has(file.fileName)) continue;
        const reference = this.emitFile({
          type: 'asset',
          fileName: `${config.build.assetsDir ? `${config.build.assetsDir.replace(/\/$/, '')}/` : ''}stream3d/${file.fileName}`,
          source: bytes,
        });
        emittedFiles.set(file.fileName, reference);
        ownReferences.add(reference);
      }
      return manifestModule(result, emittedFiles);
    },

    resolveFileUrl({ referenceId, fileName, relativePath, format }) {
      if (!ownReferences.has(referenceId)) return;
      if (config.base === '' || config.base === './') {
        if (format !== 'es') this.error('Stream3D with a relative Vite base requires an ES module output format.');
        return `new URL(${JSON.stringify(relativePath)}, import.meta.url).href`;
      }
      return JSON.stringify(`${config.base}${fileName}`);
    },

    configureServer(server) {
      devServer = server;
      const route = `${devBase(config.base)}${ASSET_ROUTE}`;
      server.middlewares.use((request, response, next) => {
        let pathname: string;
        try {
          pathname = new URL(request.url ?? '/', 'http://stream3d.local').pathname;
        } catch { next(); return; }
        if (!pathname.startsWith(route)) { next(); return; }
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          response.statusCode = 405;
          response.setHeader('Allow', 'GET, HEAD');
          response.end();
          return;
        }
        const filename = pathname.slice(route.length);
        // No filesystem path from the request is ever opened. Only outputs registered by an
        // actual ?asset module can be fetched, including when Vite allows a wider source tree.
        const file = servedFiles.get(filename);
        if (!file) { response.statusCode = 404; response.end('Unknown compiled asset'); return; }
        readFile(file.absolutePath).then((bytes) => {
          response.setHeader('Content-Type', file.mimeType);
          response.setHeader('Content-Length', bytes.byteLength);
          response.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          response.setHeader('X-Content-Type-Options', 'nosniff');
          response.statusCode = 200;
          response.end(request.method === 'HEAD' ? undefined : bytes);
        }).catch(next);
      });
    },

    handleHotUpdate(context) {
      const changed = path.resolve(context.file);
      const affected = [...dependenciesByModule].filter(([, dependencies]) => dependencies.has(changed));
      if (!affected.length) return;
      const modules = affected.flatMap(([id]) => {
        const module = context.server.moduleGraph.getModuleById(id);
        if (!module) return [];
        context.server.moduleGraph.invalidateModule(module);
        return [module];
      });
      // Scene instances retain handles and animation state; a full reload avoids silently
      // swapping application-owned instances during development without their consent.
      context.server.ws.send({ type: 'full-reload' });
      return modules;
    },
  };
}

function devBase(base: string): string {
  if (!base || base === './') return '/';
  const pathname = new URL(base, 'http://stream3d.local').pathname;
  return pathname.endsWith('/') ? pathname : `${pathname}/`;
}

function manifestModule(result: CompileResult, references: Map<string, string>): string {
  const { levels, ...metadata } = result.manifest;
  const levelCode = levels.map((level) => {
    const { url, ...fields } = level;
    const reference = references.get(url);
    if (!reference) throw new Error(`Missing emitted Stream3D level ${url}.`);
    return `{...${JSON.stringify(fields)},url:import.meta.ROLLUP_FILE_URL_${reference}}`;
  });
  const manifestReference = references.get(path.basename(result.manifestPath));
  if (!manifestReference) throw new Error('Missing emitted Stream3D manifest.');
  return `export const manifestUrl = import.meta.ROLLUP_FILE_URL_${manifestReference};\nexport default {...${JSON.stringify(metadata)},levels:[${levelCode.join(',')}]};\n`;
}

export default stream3d;
