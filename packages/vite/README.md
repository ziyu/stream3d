# @stream3d/vite

Automatic asset preparation for [Stream3D](https://github.com/ziyu/stream3d). Requires Node.js 22.12 or newer and a supported Vite peer version.

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import { stream3d } from '@stream3d/vite';

export default defineConfig({ plugins: [stream3d()] });
```

```ts
// Application code
import asset, { manifestUrl } from './model.glb?asset';
// asset is an AssetManifest; manifestUrl points to its deployable JSON file.
```

Enable typed asset imports in `vite-env.d.ts`:

```ts
/// <reference types="@stream3d/vite/client" />
```

The plugin compiles `.glb?asset` and `.gltf?asset` imports, watches local source dependencies, serves registered compiled files during development, and emits self-contained assets with production URLs respecting Vite's base. Relative source texture/buffer dependencies must be readable under the development server's filesystem policy.

Packages are developed in the source workspace; this README does not imply a published npm release. From the repository root, run `npm ci` and `npm run build` before packing packages.

See the [asset pipeline](https://github.com/ziyu/stream3d/blob/main/docs/assets.md) and [repository README](https://github.com/ziyu/stream3d#readme). MIT licensed; see LICENSE.
