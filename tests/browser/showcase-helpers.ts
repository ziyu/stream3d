import { expect, type Page, type Request, type TestInfo } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import type { AssetManifest, ManagedModel, StreamApp } from 'stream3d';
import type { FeedController } from '../../examples/playground/src/showcase/controller.js';
import type { BenchmarkReport } from '../../examples/playground/src/showcase/benchmark.js';
import type { Kit, Story } from '../../examples/playground/src/showcase/catalog.js';

interface ShowcaseHooks {
  app: StreamApp;
  controller: FeedController;
  activeIndex: number;
  controlled: boolean;
  lastBenchmark: BenchmarkReport | null;
  stories: Story[];
  assets: Record<Kit, AssetManifest>;
  goTo(index: number, smooth?: boolean): void;
  snapshot(): ReturnType<FeedController['snapshot']>;
  compare(): Promise<BenchmarkReport | null>;
}

declare global {
  interface Window {
    __stream3dShowcase: ShowcaseHooks;
    __showcaseDeparted?: ManagedModel[];
  }
}

export async function openShowcase(page: Page, query = 'profile=native&mode=progressive'): Promise<void> {
  await page.goto(`/?${query}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(window.__stream3dShowcase));
  expect(await page.evaluate(() => window.__stream3dShowcase.controlled)).toBe(true);
}

export async function ready(page: Page, index: number, coarseOnly = false): Promise<void> {
  await expect.poll(() => page.evaluate(({ index, coarseOnly }) => {
    const hook = window.__stream3dShowcase;
    const active = hook.controller.active;
    const snapshot = hook.snapshot();
    return hook.activeIndex === index && snapshot.readyObjects === snapshot.objectCount
      && snapshot.objectCount >= 18 && snapshot.visit?.firstUsefulMs !== null
      && Boolean(active?.actors.every(actor => actor.model.currentLevel !== null
        && actor.model.pendingLevel === null && (!coarseOnly || actor.model.currentLevel === 0)))
      && snapshot.runtime.scheduler.network.running === 0 && snapshot.runtime.scheduler.network.queued === 0
      && snapshot.runtime.scheduler.decode.running === 0 && snapshot.runtime.scheduler.decode.queued === 0
      && snapshot.runtime.pendingUploads === 0;
  }, { index, coarseOnly }), { timeout: 75_000 }).toBe(true);
}

export async function attachJson(testInfo: TestInfo, name: string, value: unknown): Promise<void> {
  const path = testInfo.outputPath(name);
  await writeFile(path, JSON.stringify(value, null, 2), 'utf8');
  await testInfo.attach(name, { path, contentType: 'application/json' });
}

export async function screenshot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const path = testInfo.outputPath(name);
  await page.screenshot({ path });
  await testInfo.attach(name, { path, contentType: 'image/png' });
}

export function isGlb(request: Request): boolean {
  return new URL(request.url()).pathname.endsWith('.glb');
}
