# stream3d

A managed Three.js runtime for [Stream3D](https://github.com/ziyu/stream3d): stable model handles, progressive detail selection, shared resources, automatic ownership, and cancellation when scenes change.

```ts
import { createApp } from 'stream3d';
import { HemisphereLight } from 'three';
import asset from './model.glb?asset'; // Requires @stream3d/vite.

const canvas = document.querySelector<HTMLCanvasElement>('canvas')!;
const app = createApp({ canvas, controls: true });
const scene = app.createScene();
scene.root.add(new HemisphereLight(0xffffff, 0x444444, 2));
const model = scene.addModel(asset);
app.present(scene);
await model.ready('interactive');
```

Position the scene camera for the asset's authored size and placement. A model also accepts a manifest URL, so using the Vite plugin is optional. Destroy models/scenes when their logical lifetime ends, and call `app.destroy()` when the host component unmounts.

Transforms, managed material overrides, and animation time survive detail changes. Render children may be replaced. GPU budgets are estimates and cannot evict resources with active ownership; diagnostics expose pressure when mandatory coarse content exceeds a budget. Raw Three.js resources added directly to a scene remain application-owned.

Three.js is a peer dependency; its TypeScript declarations are included as a dependency of this package. The default renderer uses WebGL2. Packages are currently developed in the source workspace; this README does not imply a published npm release. Run `npm ci` and `npm run build` from the repository root before packing.

See [architecture and lifecycle](https://github.com/ziyu/stream3d/blob/main/docs/architecture.md), [asset preparation](https://github.com/ziyu/stream3d/blob/main/docs/assets.md), and the [repository README](https://github.com/ziyu/stream3d#readme). MIT licensed; see LICENSE.
