# @stream3d/compiler

The Node.js asset compiler for [Stream3D](https://github.com/ziyu/stream3d). Requires Node.js 22.12 or newer.

Compile a local glTF 2.0 asset into complete, independently renderable GLB detail levels and a JSON manifest. The pipeline creates coarse geometry, resizes textures, applies Meshopt compression, preserves supported animation/skin structure, and verifies cached output. Texture output uses WebP, not GPU-compressed KTX2.

```ts
import { compileAsset } from '@stream3d/compiler';

const result = await compileAsset('./model.glb', {
  outDir: './public/models/model',
});
console.log(result.manifestPath);
```

After building the source workspace, the CLI can be run from the repository root:

```sh
npm ci
npm run build
node packages/compiler/dist/cli.js compile ./model.glb --out ./public/models/model
```

The packaged CLI executable is named `stream3d`. These packages are developed in the repository; this README does not imply a published npm release.

Unsupported extensions or ambiguous animation names fail explicitly. Keep original source assets; the generated levels intentionally trade geometry and texture detail for fast presentation.

See the [asset pipeline and supported inputs](https://github.com/ziyu/stream3d/blob/main/docs/assets.md) and [repository README](https://github.com/ziyu/stream3d#readme). MIT licensed; see LICENSE.
