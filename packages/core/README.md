# @stream3d/core

Resource ownership and streaming contracts for [Stream3D](https://github.com/ziyu/stream3d).

This package contains manifest validation, URL resolution, a bounded priority scheduler, a shared resource pool, and resource scopes. It has no renderer dependency. Packages are developed in the source workspace; this README does not imply a published npm release.

```ts
import { ResourcePool, ResourceScope } from '@stream3d/core';

const pool = new ResourcePool<ArrayBuffer>({
  maxBytes: 64 * 1024 * 1024,
  dispose: () => {}, // ArrayBuffers need no explicit GPU cleanup.
});
const scope = new ResourceScope();
const lease = scope.add(pool.acquire('mesh', async (signal) => {
  const response = await fetch('/mesh.glb', { signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const value = await response.arrayBuffer();
  return { value, bytes: value.byteLength };
}));

const bytes = await lease.value;
// Use bytes while owning the lease.
scope.dispose();
pool.dispose();
```

Active leases protect their values. Releasing the last pending lease cancels work; unused completed values remain eligible for idle or budget eviction. Scheduler tasks returning owned resources can provide `onDiscard` to clean up successful results that arrive after cancellation.

From the repository root, run `npm ci` and `npm run build` before packing packages.

See [architecture and lifecycle](https://github.com/ziyu/stream3d/blob/main/docs/architecture.md) and the [repository README](https://github.com/ziyu/stream3d#readme). MIT licensed; see LICENSE.
