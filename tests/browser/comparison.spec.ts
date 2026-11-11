import { expect, test, type Request } from '@playwright/test';
import { attachJson, isGlb, openShowcase, ready, screenshot } from './showcase-helpers.js';

// Keep recording and CDP response-body extraction outside the timed trials.
// Playwright requires these worker-level options at the spec's top level.
test.use({ video: 'off', trace: 'off' });

test('compares two cold runtimes against the exact same highest GLBs and measured HTTP bytes', async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  interface ObservedResponse { url: string; canonical: string; session: string; bytes: number; cacheControl: string; profile: string; status: number; timing: ReturnType<Request['timing']> }
  type CompletedRequest = Omit<ObservedResponse, 'bytes' | 'cacheControl' | 'status'> & { request: Request };
  const completed: CompletedRequest[] = [];
  const observed: ObservedResponse[] = [];
  const errors: string[] = [];
  const bodyErrors: string[] = [];
  const started: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    const url = new URL(request.url());
    if (isGlb(request) && url.searchParams.get('labSession')?.startsWith('trial-')) started.push(request.url());
  });
  page.on('requestfinished', request => {
    const url = new URL(request.url());
    const session = url.searchParams.get('labSession') ?? '';
    if (!isGlb(request) || !session.startsWith('trial-')) return;
    const canonical = new URL(url);
    canonical.searchParams.delete('labProfile');
    canonical.searchParams.delete('labSession');
    // These metadata reads are local to Playwright. Do not extract response bodies
    // through CDP while either measured trial is still running.
    completed.push({ request, url: url.href, canonical: canonical.href, session, profile: url.searchParams.get('labProfile') ?? '', timing: request.timing() });
  });
  await openShowcase(page, 'profile=fast&mode=progressive');
  await ready(page, 0);
  const report = await page.evaluate(() => window.__stream3dShowcase.compare());
  expect(report, await page.locator('#comparison-progress').textContent() ?? 'Comparison failed').not.toBeNull();
  const result = report!;
  await expect.poll(() => completed.length).toBe(result.trials.reduce((sum, trial) => sum + trial.network.requestsCompleted, 0));
  const bodyReads = await Promise.allSettled(completed.map(async ({ request, ...metadata }): Promise<ObservedResponse> => {
    const response = (await request.response())!;
    const body = await response.body();
    return { ...metadata, bytes: body.length, cacheControl: response.headers()['cache-control'] ?? '', status: response.status() };
  }));
  for (const read of bodyReads) {
    if (read.status === 'fulfilled') observed.push(read.value);
    else bodyErrors.push(read.reason instanceof Error ? read.reason.message : String(read.reason));
  }
  result.notes.push('This CI comparison disables Playwright video and tracing. Request metadata is observed during the run; CDP response-body extraction and the result screenshot occur only after both timed trials finish.');
  expect(result.schema).toBe('stream3d-benchmark/1');
  expect(result.trials).toHaveLength(2);
  expect(result.profile).toEqual({ id: 'fast', bytesPerSecond: 1_000_000, latencyMs: 80 });
  expect(result.conditions.width).toBeGreaterThan(0);
  expect(result.conditions.height).toBeGreaterThan(0);
  expect(result.conditions.animations).toBe('stopped');
  const progressive = result.trials.find(trial => trial.mode === 'progressive')!;
  const whole = result.trials.find(trial => trial.mode === 'whole')!;
  expect(progressive.highestAssetUrls).toEqual(whole.highestAssetUrls);
  expect(progressive.highestAssetPayloadBytes).toBe(whole.highestAssetPayloadBytes);
  expect(whole.highestAssetUrls).toHaveLength(result.scene.uniqueAssets);

  const sessions = new Set<string>();
  for (const trial of result.trials) {
    const responses = observed.filter(response => response.session.startsWith(`trial-${trial.mode}-`));
    const ownSessions = new Set(responses.map(response => response.session));
    expect(ownSessions.size).toBe(1);
    sessions.add([...ownSessions][0]!);
    expect(responses.every(response => response.status === 200 && response.profile === 'fast' && response.cacheControl.includes('no-store'))).toBe(true);
    const highest = responses.filter(response => trial.highestAssetUrls.includes(response.canonical));
    expect(highest.map(response => response.canonical).sort()).toEqual(trial.highestAssetUrls);
    expect(highest.reduce((sum, response) => sum + response.bytes, 0)).toBe(trial.highestAssetPayloadBytes);
    expect(responses.reduce((sum, response) => sum + response.bytes, 0)).toBe(trial.network.bytesCompleted);
    expect(trial.network.requestsCompleted).toBe(responses.length);
    expect(trial.network.bytesReceived).toBeGreaterThanOrEqual(trial.network.bytesCompleted);
    expect(trial.network.requestsActive).toBe(0);
    for (const measurement of [trial.firstUsefulMs, trial.allObjectsMs, trial.highestDetailMs]) {
      expect(Number.isFinite(measurement)).toBe(true);
      expect(measurement).toBeGreaterThan(0);
    }
  }
  expect(sessions.size).toBe(2);
  expect(whole.network.bytesReceived).toBe(whole.highestAssetPayloadBytes);
  expect(whole.network.requestsStarted).toBe(whole.highestAssetUrls.length);
  expect(new Set(started).size).toBe(started.length);
  expect(bodyErrors).toEqual([]);
  expect(errors).toEqual([]);
  await attachJson(testInfo, 'comparison-measured.json', result);
  await attachJson(testInfo, 'comparison-observed-http.json', observed);
  await screenshot(page, testInfo, 'comparison-results.png');
});
