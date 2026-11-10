import { expect, test } from '@playwright/test';
import type { Page, Route } from '@playwright/test';
import type { ManagedModel, ManagedScene, StreamApp } from '../../packages/runtime/src/index.js';
import type { Mesh, MeshStandardMaterial, Object3D } from 'three';

declare global {
  interface Window {
    __stream3d: {
      app: StreamApp;
      scenes: ManagedScene[];
      models: ManagedModel[];
      extras: ManagedModel[];
      present(index: number): void;
    };
    __stableRoot?: Object3D;
    __animationTimeBeforeRefine?: number;
    __stream3dFeed: {
      app: StreamApp;
      scenes: ManagedScene[];
      models: ManagedModel[];
      show(index: number): void;
    };
  }
}

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

async function continueUnlessCancelled(route: Route): Promise<void> {
  try { await route.continue(); }
  catch (error) {
    // Scene deactivation intentionally aborts in-flight requests held at a route gate.
    const message = error instanceof Error ? error.message : String(error);
    if (!/aborted|cancelled|canceled|interception|already handled|Target.*closed/i.test(message)) throw error;
  }
}

async function openDemo(page: Page): Promise<void> {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(window.__stream3d));
}

async function waitForLevel(page: Page, modelIndex: number, level: number): Promise<void> {
  await expect.poll(() => page.evaluate(index => {
    const model = window.__stream3d.models[index]!;
    return model.currentLevel;
  }, modelIndex)).toBe(level);
}

test('presents a rendered coarse asset before fine bytes arrive and preserves instance state', async ({ page }, testInfo) => {
  const fine = gate();
  let requests = 0;
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*.glb', async route => {
    requests++;
    if (requests > 1) await fine.promise;
    await continueUnlessCancelled(route);
  });
  try {
    await openDemo(page);
    await waitForLevel(page, 0, 0);
    await expect.poll(() => page.evaluate(() => window.__stream3d.app.diagnostics().render.triangles)).toBeGreaterThan(0);
    await page.evaluate(() => {
      const { app, models, scenes } = window.__stream3d;
      const model = models[0]!;
      window.__stableRoot = model.object3D;
      model.position.set(0.17, 0.08, 0);
      model.scale.setScalar(0.95);
      model.materials.set('Body', { color: '#ff5500', roughness: 0.23 });
      model.animation.play('Idle');
      scenes[0]!.camera.position.set(0, 0.5, 3.7);
      app.controls?.update();
    });
    await expect.poll(() => page.evaluate(() => window.__stream3d.models[0]!.pendingLevel)).not.toBeNull();
    await page.evaluate(() => {
      window.__animationTimeBeforeRefine = window.__stream3d.models[0]!.animation.time;
    });
    expect(await page.evaluate(() => window.__stream3d.models[0]!.currentLevel)).toBe(0);

    fine.release();
    await waitForLevel(page, 0, 2);
    const state = await page.evaluate(() => {
      const model = window.__stream3d.models[0]!;
      let material: MeshStandardMaterial | undefined;
      model.object3D.traverse(object => {
        const mesh = object as Mesh;
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        material ??= materials.find(candidate => candidate?.name === 'Body') as MeshStandardMaterial | undefined;
      });
      return {
        sameRoot: model.object3D === window.__stableRoot,
        position: model.position.toArray(), scale: model.scale.x,
        color: material?.color.getHexString(), roughness: material?.roughness,
        animation: model.animation.current,
        elapsed: model.animation.time,
        previousElapsed: window.__animationTimeBeforeRefine!,
        children: model.object3D.children.length,
      };
    });
    expect(state.sameRoot).toBe(true);
    expect(state.position).toEqual([0.17, 0.08, 0]);
    expect(state.scale).toBe(0.95);
    expect(state.color).toBe('ff5500');
    expect(state.roughness).toBe(0.23);
    expect(state.animation).toBe('Idle');
    expect(state.elapsed).toBeGreaterThanOrEqual(state.previousElapsed);
    expect(state.children).toBe(1);
    expect(errors).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath('playground.png'), fullPage: true });
  } finally { fine.release(); }
});

test('shares downloaded and decoded representations while keeping copy materials independent', async ({ page }) => {
  const requests = new Map<string, number>();
  // Routing disables the browser HTTP cache: sharing must come from the runtime here.
  await page.route('**/*.glb', route => {
    const url = route.request().url();
    requests.set(url, (requests.get(url) ?? 0) + 1);
    return route.continue();
  });
  await openDemo(page);
  await waitForLevel(page, 0, 2);
  await page.locator('#add-instances').click();
  await expect.poll(() => page.evaluate(() => {
    const extras = window.__stream3d.extras;
    return extras.length === 5 && extras.every(model => model.currentLevel !== null)
      && extras[0]!.pendingLevel === null && extras[1]!.pendingLevel === null
      && extras[0]!.currentLevel === extras[1]!.currentLevel;
  })).toBe(true);

  const state = await page.evaluate(() => {
    const { app, extras } = window.__stream3d;
    const meshOf = (model: ManagedModel) => {
      let result: Mesh | undefined;
      model.object3D.traverse(object => { if ((object as Mesh).isMesh) result ??= object as Mesh; });
      return result!;
    };
    const first = meshOf(extras[0]!);
    const second = meshOf(extras[1]!);
    const materialOf = (mesh: Mesh) => (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as MeshStandardMaterial;
    const before = materialOf(second).color.getHexString();
    extras[0]!.materials.set('Body', { color: '#ff0000' });
    return {
      sharedGeometry: first.geometry === second.geometry,
      independentMaterials: materialOf(first) !== materialOf(second),
      firstColor: materialOf(first).color.getHexString(),
      secondColor: materialOf(second).color.getHexString(), before,
      hits: app.diagnostics().resources.hits,
    };
  });
  expect(state.sharedGeometry).toBe(true);
  expect(state.independentMaterials).toBe(true);
  expect(state.firstColor).toBe('ff0000');
  expect(state.secondColor).toBe(state.before);
  // Five copies share at least four acquires, even if the original preview left its idle cache.
  expect(state.hits).toBeGreaterThanOrEqual(4);
  expect(requests.size).toBeGreaterThan(0);
  for (const count of requests.values()) expect(count).toBe(1);

  await page.locator('#reset').click();
  await expect.poll(() => page.evaluate(() => window.__stream3d.app.diagnostics().resources.activeLeases)).toBe(1);
  expect(await page.evaluate(() => window.__stream3d.extras.length)).toBe(0);
});

test('rapid scene switches discard stale pending loads instead of attaching hidden payloads', async ({ page }) => {
  const network = gate();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*.glb', async route => {
    await network.promise;
    await continueUnlessCancelled(route);
  });
  try {
    await openDemo(page);
    await expect.poll(() => page.evaluate(() => window.__stream3d.models[0]!.pendingLevel)).toBe(0);
    await page.evaluate(() => window.__stream3d.present(1));
    await expect.poll(() => page.evaluate(() => window.__stream3d.models[1]!.pendingLevel)).toBe(0);
    await page.evaluate(() => {
      const demo = window.__stream3d;
      demo.present(0);
      demo.present(1);
      demo.present(2);
    });
    await expect.poll(() => page.evaluate(() => window.__stream3d.models[2]!.pendingLevel)).toBe(0);
    network.release();
    await waitForLevel(page, 2, 2);
    await expect.poll(() => page.evaluate(() => window.__stream3d.app.diagnostics().resources.loading)).toBe(0);
    const state = await page.evaluate(() => ({
      models: window.__stream3d.models.map(model => ({
        level: model.currentLevel, children: model.object3D.children.length, visible: model.visible,
      })),
      leases: window.__stream3d.app.diagnostics().resources.activeLeases,
    }));
    expect(state.models[0]).toEqual({ level: null, children: 0, visible: false });
    expect(state.models[1]).toEqual({ level: null, children: 0, visible: false });
    expect(state.models[2]).toEqual({ level: 2, children: 1, visible: true });
    expect(state.leases).toBe(1);
    expect(errors).toEqual([]);
  } finally { network.release(); }
});

test('downgrades under a lower memory budget and releases managed resources on teardown', async ({ page }) => {
  await openDemo(page);
  await waitForLevel(page, 0, 2);
  const budget = await page.evaluate(() => {
    const { app, models } = window.__stream3d;
    const bytes = Math.ceil(models[0]!.manifest!.levels[0]!.estimatedGpuBytes * 1.1);
    app.setBudgets({ gpuBytes: bytes });
    return bytes;
  });
  await waitForLevel(page, 0, 0);
  await expect.poll(() => page.evaluate(() => window.__stream3d.app.diagnostics().estimatedGpuBytes)).toBeLessThanOrEqual(budget);
  expect(await page.evaluate(() => window.__stream3d.app.diagnostics().resources.activeLeases)).toBe(1);

  const diagnostics = await page.evaluate(() => {
    const { app } = window.__stream3d;
    app.destroy();
    app.destroy();
    return app.diagnostics();
  });
  expect(diagnostics.scenes).toBe(0);
  expect(diagnostics.models).toBe(0);
  expect(diagnostics.resources.activeLeases).toBe(0);
  expect(diagnostics.resources.entries).toBe(0);
  expect(diagnostics.resources.bytes).toBe(0);
  expect(diagnostics.bytes.entries).toBe(0);
  expect(diagnostics.pendingUploads).toBe(0);
});

test('native scrolling switches the single-canvas feed to Helix and restores Orbit on return', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/feed.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(window.__stream3dFeed));
  await expect(page.locator('#feed-name')).toHaveText('Orbit');
  await expect.poll(() => page.evaluate(() => window.__stream3dFeed.models[0]!.currentLevel)).not.toBeNull();
  await expect.poll(() => page.evaluate(() => window.__stream3dFeed.app.diagnostics().render.triangles)).toBeGreaterThan(0);
  const initialRootId = await page.evaluate(() => {
    const model = window.__stream3dFeed.models[0]!;
    model.rotation.y = 0.7;
    return model.object3D.uuid;
  });

  await page.evaluate(() => window.scrollTo({ top: window.innerHeight * 2, behavior: 'instant' }));
  await expect(page.locator('#feed-name')).toHaveText('Helix');
  await expect(page.locator('[data-feed-scene="2"]')).toHaveAttribute('aria-current', 'true');
  await expect.poll(() => page.evaluate(() => window.__stream3dFeed.models[2]!.currentLevel)).not.toBeNull();
  expect(await page.evaluate(() => window.__stream3dFeed.models[0]!.object3D.children.length)).toBe(0);
  await expect(page.locator('canvas')).toHaveCount(1);

  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await expect(page.locator('#feed-name')).toHaveText('Orbit');
  await expect.poll(() => page.evaluate(() => window.__stream3dFeed.models[0]!.currentLevel)).not.toBeNull();
  const returned = await page.evaluate(() => {
    const { app, models } = window.__stream3dFeed;
    return {
      rootId: models[0]!.object3D.uuid,
      rotation: models[0]!.rotation.y,
      previousChildren: models[2]!.object3D.children.length,
      active: app.diagnostics().activeModels,
    };
  });
  expect(returned.rootId).toBe(initialRootId);
  expect(returned.rotation).toBe(0.7);
  expect(returned.previousChildren).toBe(0);
  expect(returned.active).toBe(1);
  expect(errors).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('feed.png') });
});
