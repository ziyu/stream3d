import { expect, test } from '@playwright/test';
import type { Mesh, MeshStandardMaterial } from 'three';
import type { ManagedModel } from 'stream3d';
import { attachJson, isGlb, openShowcase, ready, screenshot } from './showcase-helpers.js';

// Record interactive browsing evidence. The comparison has a separate spec so its
// worker-level recording options can be disabled without affecting these tests.
test.use({ video: 'on' });

test('renders a complex shared-asset world with many managed objects and real triangles', async ({ page }, testInfo) => {
  test.setTimeout(150_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await openShowcase(page);
  await ready(page, 0);
  await expect.poll(() => page.evaluate(() => window.__stream3dShowcase.snapshot().runtime.render.triangles)).toBeGreaterThan(50_000);
  await expect(page.locator('.story-page')).toHaveCount(30);
  await expect(page.locator('canvas')).toHaveCount(1);
  await expect(page.locator('#story-title')).toHaveText('The Glasshouse');

  // Equal settled tiers are necessary before comparing geometry identities.
  await expect.poll(() => page.evaluate(() => {
    const actors = window.__stream3dShowcase.controller.active!.actors.filter(actor => actor.kit === 'luminaire');
    return actors.some((first, index) => first.model.currentLevel !== null && actors.slice(index + 1).some(second =>
      first.model.currentLevel === second.model.currentLevel && first.model.pendingLevel === null && second.model.pendingLevel === null));
  })).toBe(true);
  const measured = await page.evaluate(() => {
    const hook = window.__stream3dShowcase;
    const actors = hook.controller.active!.actors.filter(actor => actor.kit === 'luminaire');
    const mesh = (model: ManagedModel) => {
      let result: Mesh | undefined;
      model.object3D.traverse(object => { if ((object as Mesh).isMesh) result ??= object as Mesh; });
      return result!;
    };
    const firstActor = actors.find((first, index) => first.model.currentLevel !== null
      && actors.slice(index + 1).some(second => first.model.currentLevel === second.model.currentLevel))!;
    const secondActor = actors.find(actor => actor !== firstActor && actor.model.currentLevel === firstActor.model.currentLevel)!;
    const first = mesh(firstActor.model);
    const second = mesh(secondActor.model);
    return {
      snapshot: hook.snapshot(),
      uniqueHighestTriangles: Object.values(hook.assets).reduce((sum, asset) => sum + asset.levels.at(-1)!.triangles, 0),
      sharedGeometry: first.geometry === second.geometry,
      independentMaterials: first.material !== second.material,
    };
  });
  expect(measured.snapshot.objectCount).toBeGreaterThanOrEqual(18);
  expect(measured.snapshot.uniqueAssets).toBe(6);
  expect(measured.uniqueHighestTriangles).toBeGreaterThan(500_000);
  expect(measured.snapshot.runtime.resources.hits).toBeGreaterThanOrEqual(measured.snapshot.objectCount - measured.snapshot.uniqueAssets);
  expect(measured.sharedGeometry).toBe(true);
  expect(measured.independentMaterials).toBe(true);
  expect(errors).toEqual([]);
  await attachJson(testInfo, 'desktop-world-measured.json', measured);
  await screenshot(page, testInfo, 'desktop-world.png');

  // Exercise the native feed surface, outside the independently scrolling panel.
  const canvas = (await page.locator('#scene-canvas').boundingBox())!;
  await page.mouse.move(canvas.x + canvas.width * 0.5, canvas.y + canvas.height * 0.35);
  await page.mouse.wheel(0, await page.evaluate(() => innerHeight));
  await expect.poll(() => page.evaluate(() => window.__stream3dShowcase.activeIndex)).toBe(1);
  await expect(page.locator('#story-title')).toHaveText('Reactor District');
  await ready(page, 1);
  const overview = await page.evaluate(() => ({
    camera: window.__stream3dShowcase.controller.active!.scene.camera.position.toArray(),
    scrollY,
  }));
  expect(overview.scrollY).toBeGreaterThan(0);
  await page.locator('#inspect-hero').click();
  await expect(page.locator('#inspect-hero')).toHaveText(/Return to overview/);
  await expect.poll(() => page.evaluate(previous => {
    const active = window.__stream3dShowcase.controller.active!;
    return active.close && active.scene.camera.position.toArray().some((coordinate, index) => Math.abs(coordinate - previous[index]!) > 1);
  }, overview.camera)).toBe(true);

  const finishBefore = await page.evaluate(() => {
    const selected = window.__stream3dShowcase.controller.selected!;
    const colors: string[] = [];
    selected.model.object3D.traverse(object => {
      const material = (object as Mesh).material;
      for (const item of Array.isArray(material) ? material : material ? [material] : []) {
        if (item.name === 'Shell') colors.push((item as MeshStandardMaterial).color.getHexString());
      }
    });
    return { kit: selected.kit, colors: [...new Set(colors)].sort() };
  });
  expect(finishBefore.kit).toBe('reactor');
  expect(finishBefore.colors.length).toBeGreaterThan(0);
  await page.locator('#recolor-selection').click();
  const inspected = await page.evaluate(() => {
    const controller = window.__stream3dShowcase.controller;
    const colors: string[] = [];
    controller.selected!.model.object3D.traverse(object => {
      const material = (object as Mesh).material;
      for (const item of Array.isArray(material) ? material : material ? [material] : []) {
        if (item.name === 'Shell') colors.push((item as MeshStandardMaterial).color.getHexString());
      }
    });
    return { colors: [...new Set(colors)].sort(), camera: controller.active!.scene.camera.position.toArray() };
  });
  expect(inspected.colors.length).toBeGreaterThan(0);
  expect(inspected.colors).not.toEqual(finishBefore.colors);
  await page.locator('#inspect-hero').click();
  await expect(page.locator('#inspect-hero')).toHaveText(/Move closer/);
  await expect.poll(() => page.evaluate(previous => {
    const active = window.__stream3dShowcase.controller.active!;
    return !active.close && active.scene.camera.position.toArray().some((coordinate, index) => Math.abs(coordinate - previous[index]!) > 1);
  }, inspected.camera)).toBe(true);
  await ready(page, 1);
  await screenshot(page, testInfo, 'reactor-district.png');
  await page.evaluate(() => window.__stream3dShowcase.goTo(3));
  await ready(page, 3);
  await expect(page.locator('#story-title')).toHaveText('After Hours');
  await screenshot(page, testInfo, 'after-hours-night.png');
  await attachJson(testInfo, 'world-interactions-measured.json', {
    overview, finishBefore, inspected, night: await page.evaluate(() => window.__stream3dShowcase.snapshot()),
  });
  expect(errors).toEqual([]);
});

test('returns to a destroyed card using retained bytes without repeating shared GLB requests', async ({ page }, testInfo) => {
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 390, height: 844 });
  const requests: string[] = [];
  const cacheHeaders: string[] = [];
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (isGlb(request)) requests.push(request.url()); });
  page.on('response', response => {
    if (new URL(response.url()).pathname.endsWith('.glb')) cacheHeaders.push(response.headers()['cache-control'] ?? '');
  });
  await openShowcase(page);
  // A one-byte soft residency budget still protects the visible coarse minimum, but
  // evicts completed templates when a scene releases them. Byte cache is separate.
  await page.evaluate(() => window.__stream3dShowcase.app.setBudgets({ gpuBytes: 1 }));
  await ready(page, 0, true);
  const before = await page.evaluate(() => ({
    snapshot: window.__stream3dShowcase.snapshot(),
    heroId: window.__stream3dShowcase.controller.active!.hero.model.id,
  }));
  const requestsBefore = [...requests];
  // This night scene does not use coral. Other kits may keep their decoded payloads
  // through scene handoff; coral must leave residency and later return from bytes.
  await page.evaluate(() => window.__stream3dShowcase.goTo(27));
  await ready(page, 27, true);
  expect(await page.evaluate(() => window.__stream3dShowcase.controller.bundles.has(0))).toBe(false);
  await page.evaluate(() => window.__stream3dShowcase.goTo(0));
  await ready(page, 0, true);
  const returned = await page.evaluate(() => ({
    snapshot: window.__stream3dShowcase.snapshot(),
    heroId: window.__stream3dShowcase.controller.active!.hero.model.id,
  }));
  expect(returned.heroId).not.toBe(before.heroId);
  expect(returned.snapshot.runtime.resources.evictions).toBeGreaterThan(before.snapshot.runtime.resources.evictions);
  expect(returned.snapshot.runtime.bytes.hits).toBeGreaterThan(before.snapshot.runtime.bytes.hits);
  expect(returned.snapshot.runtime.network.requestsStarted).toBe(before.snapshot.runtime.network.requestsStarted);
  expect(requests).toEqual(requestsBefore);
  expect(cacheHeaders.length).toBeGreaterThanOrEqual(6);
  expect(cacheHeaders.every(value => value.includes('no-store'))).toBe(true);
  expect(errors).toEqual([]);
  await attachJson(testInfo, 'mobile-return-cache-measured.json', { before, returned, observedGlbRequests: requests });
  await screenshot(page, testInfo, 'mobile-collection.png');
});

test('bounds scene ownership across 30 rapid skips, cancels work and evicts only idle memory', async ({ page }, testInfo) => {
  test.setTimeout(150_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await openShowcase(page, 'profile=slow&mode=progressive');
  await page.evaluate(() => window.__stream3dShowcase.app.setBudgets({ gpuBytes: 1 }));
  await expect.poll(() => page.evaluate(() => window.__stream3dShowcase.snapshot().runtime.network.requestsActive)).toBeGreaterThan(0);
  const tour = await page.evaluate(async () => {
    const hook = window.__stream3dShowcase;
    window.__showcaseDeparted = hook.controller.active!.actors.map(actor => actor.model);
    const observations = [];
    for (let index = 0; index < hook.stories.length; index++) {
      hook.goTo(index);
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      const snapshot = hook.snapshot();
      observations.push({ index: snapshot.activeIndex, scenes: snapshot.runtime.scenes, models: snapshot.runtime.models, retained: snapshot.retainedScenes });
    }
    return { observations, maximumObjectsPerCard: Math.max(...hook.stories.map(story => story.actors.length)) };
  });
  expect(tour.observations.map(value => value.index)).toEqual(Array.from({ length: 30 }, (_, index) => index));
  for (const sample of tour.observations) {
    expect(sample.retained).toBeLessThanOrEqual(3);
    expect(sample.scenes).toBeLessThanOrEqual(3);
    expect(sample.models).toBeLessThanOrEqual(tour.maximumObjectsPerCard * 3);
  }
  await ready(page, 29, true);
  const before = await page.evaluate(() => window.__stream3dShowcase.snapshot());
  expect(before.runtime.network.requestsAborted).toBeGreaterThan(0);
  expect(before.runtime.network.requestsActive).toBe(0);
  expect(before.runtime.bytes.entries).toBeGreaterThan(1);
  const release = await page.evaluate(() => {
    const hook = window.__stream3dShowcase;
    const previous = hook.snapshot();
    const budget = previous.runtime.bytes.bytes - 1;
    hook.app.setBudgets({ cacheBytes: budget });
    const afterBudget = hook.snapshot();
    const cleared = hook.controller.clearCache();
    return {
      budget, afterBudget, cleared, afterClear: hook.snapshot(),
      departed: window.__showcaseDeparted!.map(model => ({ level: model.currentLevel, pending: model.pendingLevel, children: model.object3D.children.length, visible: model.visible })),
    };
  });
  expect(release.afterBudget.runtime.bytes.bytes).toBeLessThanOrEqual(release.budget);
  expect(release.afterBudget.runtime.bytes.evictions).toBeGreaterThan(before.runtime.bytes.evictions);
  expect(release.cleared.bytes.entries).toBeGreaterThan(0);
  expect(release.afterClear.runtime.bytes.bytes).toBe(0);
  expect(release.afterClear.readyObjects).toBe(before.readyObjects);
  expect(release.afterClear.runtime.resources.activeLeases).toBe(before.runtime.resources.activeLeases);
  expect(release.afterClear.runtime.render.triangles).toBeGreaterThan(0);
  for (const model of release.departed) expect(model).toEqual({ level: null, pending: null, children: 0, visible: false });
  expect(errors).toEqual([]);
  await attachJson(testInfo, 'rapid-browse-measured.json', { tour, before, release });
});
