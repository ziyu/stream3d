import './style.css';
import { assets, stories } from './catalog.js';
import { FeedController } from './controller.js';
import { NETWORK_PROFILES, type NetworkProfileId } from './network-profiles.js';
import { runComparison, type BenchmarkReport, type TrialProgress, type TrialResult } from './benchmark.js';
import type { LoadingMode } from './scenes.js';

document.querySelector('#showcase')!.innerHTML = `
  <div id="canvas-host"><canvas id="scene-canvas" aria-label="Interactive 3D world. Drag sideways to orbit; scroll vertically to explore the collection."></canvas></div>
  <div class="world-vignette" aria-hidden="true"></div>
  <header class="world-header">
    <a class="world-brand" href="./"><span class="brand-symbol" aria-hidden="true">s</span>stream<span>3d</span><small> / WORLDS</small></a>
    <div class="collection-marker"><i></i>30 SCENES · 6 SHARED ASSET KITS</div>
    <nav><a href="./inspector.html">API playground ↗</a><button id="toggle-panel" aria-expanded="false" aria-controls="engine-panel">Runtime ↗</button><a href="https://github.com/ziyu/stream3d" target="_blank" rel="noreferrer">GitHub ↗</a></nav>
  </header>
  <main id="story-pages" aria-label="Scrollable collection of 30 interactive 3D worlds">
    ${stories.map(story => `<section class="story-page" aria-label="${story.title}, scene ${story.index + 1} of ${stories.length}"></section>`).join('')}
  </main>
  <div class="world-topline"><span id="world-collection"></span><span class="ready-status" id="scene-status" role="status">PREPARING A WORLD</span></div>
  <div class="world-loading" id="world-loading"><span class="loading-orbit" aria-hidden="true"></span><div><strong id="loading-title">Building the first view</strong><span id="loading-detail">Geometry and textures arrive progressively.</span></div></div>
  <section class="world-caption" aria-label="Current scene">
    <p class="world-kicker"><span id="story-number">01</span><span class="kicker-line"></span><span id="story-category">A COLLECTION OF LIVING WORLDS</span></p>
    <h1 id="story-title">The Glasshouse</h1>
    <p class="world-description" id="story-description"></p>
    <div class="world-facts"><span><strong id="story-objects">—</strong> objects</span><span><strong id="story-assets">—</strong> asset kits</span><span><strong id="story-full-size">—</strong> highest-detail payload</span></div>
    <div class="world-actions"><button id="inspect-hero" class="world-primary">Move closer <span>↗</span></button><button id="trigger-motion">Open the pavilion</button><button id="recolor-selection" title="A per-instance material edit survives detail changes.">Change finish</button></div>
    <p class="selection-hint" id="selection-hint">Click any object to select it. Drag sideways to orbit.</p>
  </section>
  <aside id="engine-panel" class="engine-panel" aria-label="Live streaming diagnostics">
    <div class="panel-heading"><div><p class="panel-eyebrow">UNDER THE SURFACE</p><h2>Streaming, visible.</h2></div><span class="live-indicator">LIVE</span></div>
    <p class="panel-intro">Explore a world, then leave it. Watch which work is shared, completed or cancelled.</p>
    <div class="mode-switch" role="group" aria-label="Loading strategy"><button data-loading-mode="progressive" aria-pressed="true">Progressive</button><button data-loading-mode="whole" aria-pressed="false">Whole asset</button></div>
    <div class="profile-controls"><label for="network-profile">Network laboratory</label><select id="network-profile">${Object.entries(NETWORK_PROFILES).map(([id, profile]) => `<option value="${id}">${profile.label}</option>`).join('')}</select><p id="network-note">Checking HTTP pacing support…</p></div>
    <dl class="main-metrics"><div><dt>First useful view <span title="Terrain and hero ready, followed by two animation frames. Includes scene construction; engine is already loaded.">ⓘ</span></dt><dd id="metric-useful">—</dd></div><div><dt>Objects ready</dt><dd id="metric-ready">0 / 0</dd></div></dl>
    <div class="quality-track" aria-label="Current representation distribution"><span class="quality-preview" id="quality-preview"></span><span class="quality-standard" id="quality-standard"></span><span class="quality-full" id="quality-full"></span></div>
    <div class="quality-legend"><span><i class="preview-dot"></i>Preview <b id="count-preview">0</b></span><span><i class="standard-dot"></i>Standard <b id="count-standard">0</b></span><span><i class="full-dot"></i>Full <b id="count-full">0</b></span></div>
    <div class="metric-grid"><div><span>Received payload</span><strong id="metric-bytes">0 B</strong></div><div><span>Shared acquisitions</span><strong id="metric-reuse">0</strong></div><div><span>Requests cancelled</span><strong id="metric-cancelled">0</strong></div><div><span>Drawn triangles</span><strong id="metric-triangles">0</strong></div></div>
    <div class="resident-heading"><span>Resident estimate</span><strong id="metric-resident">0 MiB</strong></div>
    <svg class="resident-chart" viewBox="0 0 280 58" role="img" aria-label="Recent estimated resident memory"><path class="chart-grid" d="M0 56H280 M0 29H280 M0 2H280"></path><path id="resident-area" class="chart-area"></path><path id="resident-line" class="chart-line"></path><path id="memory-budget-line" class="chart-budget"></path></svg>
    <div class="resident-caption"><span id="metric-peak">Sampled peak —</span><span id="metric-window">0 / 30 scenes retained</span></div>
    <div class="budget-row"><label for="resident-budget">Residency budget</label><select id="resident-budget"><option value="16">16 MiB</option><option value="48">48 MiB</option><option value="96" selected>96 MiB</option><option value="192">192 MiB</option></select></div>
    <p class="pressure-note" id="memory-pressure" hidden>Visible minimum detail exceeds this soft budget. Active resources remain valid.</p>
    <div class="frame-row"><span>Recent RAF p95 <strong id="metric-frame">—</strong></span><span id="metric-requests">0 requests</span></div>
    <div class="lab-actions"><button id="rapid-browse">Rapid browse <span>30 scenes →</span></button><button id="clear-cache">Release idle cache</button></div>
    <button id="compare-loading" class="compare-button">Run a cold-load comparison <span>↗</span></button>
    <p class="measurement-note">Actual response-body bytes. Memory is estimated; frame intervals are measured. Network profiles pace HTTP bodies on this local demo server.</p>
    <details class="activity-details"><summary>Resource activity <span id="queue-summary"></span></summary><ol id="activity-log"></ol><button id="export-session">Export session metrics ↓</button></details>
  </aside>
  <footer class="world-footer"><div class="browse-hint"><span class="scroll-glyph" aria-hidden="true">↓</span><div>SCROLL TO DISCOVER<span>Horizontal drag rotates the world.</span></div></div><button id="previous-world" aria-label="Previous world">↑</button><button id="next-world" class="next-world"><span>UP NEXT</span><strong id="next-title">Reactor District</strong><span>↓</span></button><span class="page-counter" id="page-counter">01 / 30</span></footer>
  <div id="demo-toast" class="demo-toast" role="status" hidden></div>
  <dialog id="comparison-dialog" class="comparison-dialog" aria-labelledby="comparison-title">
    <div class="comparison-heading"><div><p class="panel-eyebrow">CONTROLLED ASSET COLD START</p><h2 id="comparison-title">Measure the difference.</h2></div><button id="close-comparison" aria-label="Close comparison">×</button></div>
    <p class="comparison-explainer">The same scene, camera and highest-detail GLBs. Two fresh runtimes, independent no-store asset URLs, shared bandwidth per trial. Animations are stopped; the engine is already loaded.</p>
    <p id="comparison-progress" class="comparison-progress" role="status">Preparing trials…</p>
    <div id="comparison-results" class="comparison-results"></div>
    <p class="comparison-caveat">First useful = terrain + hero ready, then two RAF callbacks. Progressive can transfer more total bytes because it also loads intermediate detail. Driver and decoder caches may remain warm. These are measurements of this session, not a device-wide guarantee.</p>
    <div class="comparison-footer"><button id="download-comparison" disabled>Download measured results ↓</button><button id="finish-comparison">Cancel comparison</button></div>
  </dialog>
`;

const element = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const text = (selector: string, value: string) => { element(selector).textContent = value; };
const formatBytes = (value: number) => value < 1024 ? `${value.toFixed(0)} B` : value < 1024 ** 2 ? `${(value / 1024).toFixed(0)} KiB` : `${(value / 1024 ** 2).toFixed(1)} MiB`;
const formatTime = (value: number | null) => value === null ? '—' : value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(2)} s`;
const query = new URL(location.href).searchParams;
const requestedProfile = query.get('profile');
let profile: NetworkProfileId = requestedProfile && Object.hasOwn(NETWORK_PROFILES, requestedProfile) ? requestedProfile as NetworkProfileId : 'fast';
let mode: LoadingMode = query.get('mode') === 'whole' ? 'whole' : 'progressive';
let budget = 96;
let controlled = false;
let controller: FeedController;
let activeIndex = Math.max(0, Math.min(stories.length - 1, Math.trunc((Number(query.get('card')) || 1) - 1)));
let previousActive = -1;
let benchmarkAbort: AbortController | null = null;
let lastBenchmark: BenchmarkReport | null = null;
let tourTimer: ReturnType<typeof setInterval> | null = null;
let toastTimer: ReturnType<typeof setTimeout> | null = null;
let colorIndex = 0;
let lastCancellations = 0;
let disposed = false;
let frame = 0;
const dialog = element<HTMLDialogElement>('#comparison-dialog');
const benchmarkResults = new Map<LoadingMode, TrialResult>();
for (const control of document.querySelectorAll<HTMLButtonElement | HTMLSelectElement>('button, select')) control.disabled = true;

function toast(message: string): void {
  const target = element('#demo-toast');
  target.textContent = message;
  target.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { target.hidden = true; }, 3500);
}

function createCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.id = 'scene-canvas';
  canvas.setAttribute('aria-label', 'Interactive 3D world. Drag sideways to orbit; scroll to continue.');
  element('#canvas-host').replaceChildren(canvas);
  bindDrag(canvas);
  return canvas;
}

function restart(): void {
  controller?.destroy();
  controller = new FeedController(createCanvas(), { mode, profile, session: `feed-${crypto.randomUUID()}`, controlled }, budget);
  lastCancellations = 0;
  controller.show(activeIndex);
  element<HTMLSelectElement>('#network-profile').value = profile;
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-loading-mode]')) button.setAttribute('aria-pressed', String(button.dataset.loadingMode === mode));
  updateStory();
  updateMetrics();
}

function updateStory(): void {
  const story = stories[activeIndex]!;
  document.documentElement.style.setProperty('--world-accent', story.accent);
  text('#story-number', String(activeIndex + 1).padStart(2, '0'));
  text('#story-title', story.title);
  text('#story-description', story.description);
  text('#world-collection', story.collection);
  text('#story-category', `WORLD ${String(activeIndex + 1).padStart(2, '0')} / ${stories.length}`);
  text('#story-objects', String(story.actors.length));
  const kits = [...new Set(story.actors.map(actor => actor.kit))];
  text('#story-assets', String(kits.length));
  const uniquePayload = new Map(kits.map(kit => { const level = assets[kit].levels.at(-1)!; return [level.url, level.byteLength]; }));
  text('#story-full-size', formatBytes([...uniquePayload.values()].reduce((sum, bytes) => sum + bytes, 0)));
  text('#page-counter', `${String(activeIndex + 1).padStart(2, '0')} / ${stories.length}`);
  text('#next-title', stories[(activeIndex + 1) % stories.length]!.title);
  text('#trigger-motion', controller.active?.hero.kit === 'pavilion' ? 'Open the pavilion' : 'Replay the motion');
  text('#inspect-hero', controller.active?.close ? 'Return to overview ↙' : 'Move closer ↗');
  element<HTMLButtonElement>('#previous-world').disabled = activeIndex === 0;
  const url = new URL(location.href);
  url.searchParams.set('card', String(activeIndex + 1));
  url.searchParams.set('profile', profile);
  url.searchParams.set('mode', mode);
  history.replaceState(null, '', url);
}

function goTo(index: number, smooth = false): void {
  if (benchmarkAbort) return;
  const next = Math.max(0, Math.min(stories.length - 1, Math.round(index)));
  const section = document.querySelectorAll<HTMLElement>('.story-page')[next]!;
  section.scrollIntoView({ behavior: smooth && !matchMedia('(prefers-reduced-motion: reduce)').matches ? 'smooth' : 'instant' });
  if (!smooth) activate(next);
}

function activate(index: number): void {
  if (benchmarkAbort || !controller || index === previousActive) return;
  activeIndex = index;
  previousActive = index;
  controller.show(index);
  updateStory();
}

function fromScroll(): void {
  if (!controller || benchmarkAbort) return;
  let nearest = 0;
  let distance = Infinity;
  document.querySelectorAll<HTMLElement>('.story-page').forEach((section, index) => {
    const rect = section.getBoundingClientRect();
    const candidate = Math.abs(rect.top + rect.height / 2 - innerHeight / 2);
    if (candidate < distance) { distance = candidate; nearest = index; }
  });
  activate(nearest);
}

function bindDrag(canvas: HTMLCanvasElement): void {
  let drag: { id: number; x: number; y: number; yaw: number; index: number } | null = null;
  canvas.addEventListener('pointerdown', event => {
    if (event.button !== 0 || benchmarkAbort || !controller?.active) return;
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, yaw: controller.active.yaw, index: activeIndex };
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.id || drag.index !== activeIndex || !controller.active) return;
    const dx = event.clientX - drag.x;
    if (Math.abs(dx) > Math.abs(event.clientY - drag.y)) controller.active.yaw = drag.yaw - dx * 0.006;
  });
  canvas.addEventListener('pointerup', () => { drag = null; });
  canvas.addEventListener('pointercancel', () => { drag = null; });
}

function drawMemoryChart(): void {
  const samples = controller.history;
  const max = Math.max(budget * 1024 ** 2, ...samples.map(sample => sample.resident), 1) * 1.08;
  const points = samples.map((sample, i) => `${(i / Math.max(1, samples.length - 1) * 280).toFixed(1)},${(56 - sample.resident / max * 54).toFixed(1)}`);
  element('#resident-line').setAttribute('d', points.length ? `M${points.join(' L')}` : '');
  element('#resident-area').setAttribute('d', points.length ? `M0,58 L${points.join(' L')} L280,58 Z` : '');
  const budgetY = 56 - budget * 1024 ** 2 / max * 54;
  document.querySelector<SVGPathElement>('#memory-budget-line')!.setAttribute('d', `M0,${budgetY.toFixed(1)}H280`);
}

function updateMetrics(): void {
  if (!controller || benchmarkAbort || disposed) return;
  const sample = controller.sample();
  const d = sample.runtime;
  text('#metric-useful', formatTime(sample.visit?.firstUsefulMs ?? null));
  text('#metric-ready', `${sample.readyObjects} / ${sample.objectCount}`);
  text('#metric-bytes', formatBytes(d.network.bytesReceived));
  text('#metric-reuse', d.resources.hits.toLocaleString());
  text('#metric-cancelled', d.network.requestsAborted.toLocaleString());
  text('#metric-triangles', d.render.triangles.toLocaleString());
  text('#metric-resident', formatBytes(d.estimatedGpuBytes));
  text('#metric-peak', `Sampled peak ${formatBytes(sample.peakResidentBytes)}`);
  text('#metric-window', `${sample.retainedScenes} / 30 scenes retained`);
  text('#metric-frame', sample.frames.samples ? `${sample.frames.p95Ms.toFixed(1)} ms` : '—');
  text('#metric-requests', `${d.network.requestsActive} active / ${d.network.requestsStarted} started`);
  text('#queue-summary', `NET ${d.scheduler.network.queued} · DECODE ${d.scheduler.decode.queued}`);
  for (const quality of ['preview', 'standard', 'full'] as const) {
    text(`#count-${quality}`, String(sample.quality[quality]));
    element(`#quality-${quality}`).style.width = `${sample.quality[quality] / Math.max(1, sample.objectCount) * 100}%`;
  }
  element('#memory-pressure').hidden = !d.gpuPressure;
  const ready = sample.visit?.firstUsefulMs != null;
  text('#scene-status', ready ? `INTERACTIVE · ${sample.readyObjects}/${sample.objectCount} OBJECTS` : `${sample.readyObjects}/${sample.objectCount} OBJECTS ARRIVED`);
  element('#world-loading').hidden = Boolean(ready);
  text('#loading-title', sample.visit?.error ? 'This scene could not finish loading' : 'Building the first view');
  text('#loading-detail', sample.visit?.error ?? `${sample.readyObjects} objects ready · ${formatBytes(d.network.bytesReceived)} received this session`);
  text('#selection-hint', controller.selected ? `${controller.selected.label} selected · Drag sideways to orbit · Scroll to continue` : 'Click any object to select it.');
  if (d.network.requestsAborted > lastCancellations) {
    controller.record(`${d.network.requestsAborted - lastCancellations} superseded HTTP request(s) cancelled`);
    lastCancellations = d.network.requestsAborted;
  }
  element('#activity-log').replaceChildren(...controller.events.map(event => {
    const item = document.createElement('li');
    item.textContent = event.text;
    return item;
  }));
  drawMemoryChart();
}

function stopTour(): void {
  if (tourTimer) clearInterval(tourTimer);
  tourTimer = null;
  element('#rapid-browse').innerHTML = 'Rapid browse <span>30 scenes →</span>';
}

function exportJson(value: unknown, filename: string): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function renderResults(): void {
  element('#comparison-results').innerHTML = (['progressive', 'whole'] as const).map(strategy => {
    const result = benchmarkResults.get(strategy);
    return `<article class="trial-result ${strategy}"><p>${strategy === 'progressive' ? 'STREAM3D · PROGRESSIVE' : 'SAME ASSETS · WHOLE HIGHEST LEVEL'}</p><strong>${result ? formatTime(result.firstUsefulMs) : '—'}</strong><span>first useful view</span><dl><div><dt>All objects ready</dt><dd>${result ? formatTime(result.allObjectsMs) : 'Waiting'}</dd></div><div><dt>All highest detail</dt><dd>${result ? formatTime(result.highestDetailMs) : 'Waiting'}</dd></div><div><dt>Payload at first view</dt><dd>${result ? formatBytes(result.bytesAtFirstUseful) : '—'}</dd></div><div><dt>Total payload</dt><dd>${result ? formatBytes(result.network.bytesReceived) : '—'}</dd></div><div><dt>Recent frame p95</dt><dd>${result ? `${result.frameIntervals.p95Ms.toFixed(1)} ms` : '—'}</dd></div></dl></article>`;
  }).join('');
}

async function compare(): Promise<BenchmarkReport | null> {
  if (!controlled || benchmarkAbort || disposed) return null;
  stopTour();
  benchmarkAbort = new AbortController();
  const abort = benchmarkAbort;
  try {
    controller.destroy();
    lastBenchmark = null;
    benchmarkResults.clear();
    renderResults();
    element<HTMLButtonElement>('#download-comparison').disabled = true;
    text('#finish-comparison', 'Cancel comparison');
    document.body.classList.add('comparing');
    if (!dialog.open) dialog.showModal();
    text('#comparison-progress', `Starting independent trials · ${NETWORK_PROFILES[profile].label}`);
    const report = await runComparison({
      createCanvas, story: stories[activeIndex]!, profile, signal: abort.signal,
      onProgress(progress: TrialProgress) {
        text('#comparison-progress', `${progress.mode === 'progressive' ? 'Progressive' : 'Whole asset'} · ${progress.ready}/${progress.total} objects · ${formatBytes(progress.bytesReceived)} received · ${formatTime(progress.elapsedMs)}`);
      },
      onResult(result) { benchmarkResults.set(result.mode, result); renderResults(); },
    });
    lastBenchmark = report;
    text('#comparison-progress', `Measured both modes · ${report.scene.objects} objects · ${NETWORK_PROFILES[profile].label}`);
    element<HTMLButtonElement>('#download-comparison').disabled = false;
    return report;
  } catch (error) {
    text('#comparison-progress', abort.signal.aborted ? 'Comparison cancelled.' : error instanceof Error ? error.message : String(error));
    return null;
  } finally {
    benchmarkAbort = null;
    text('#finish-comparison', 'Back to the collection');
    document.body.classList.remove('comparing');
    if (!disposed) restart();
  }
}

element('#next-world').addEventListener('click', () => goTo((activeIndex + 1) % stories.length, true));
element('#previous-world').addEventListener('click', () => goTo(activeIndex - 1, true));
element('#toggle-panel').addEventListener('click', () => {
  const open = document.body.classList.toggle('panel-open');
  element('#toggle-panel').setAttribute('aria-expanded', String(open));
});
element<HTMLSelectElement>('#network-profile').addEventListener('change', event => {
  profile = (event.target as HTMLSelectElement).value as NetworkProfileId;
  stopTour();
  restart();
  toast('Started a new asset-cache session with this network profile.');
});
element<HTMLSelectElement>('select#resident-budget').addEventListener('change', event => {
  budget = Number((event.target as HTMLSelectElement).value);
  controller.app.setBudgets({ gpuBytes: budget * 1024 ** 2 });
  controller.record(`Residency budget changed to ${budget} MiB`);
});
document.querySelectorAll<HTMLButtonElement>('[data-loading-mode]').forEach(button => button.addEventListener('click', () => {
  const next = button.dataset.loadingMode as LoadingMode;
  if (next !== mode) { mode = next; stopTour(); restart(); toast('Started a fresh cache session for this loading strategy.'); }
}));
element('#inspect-hero').addEventListener('click', () => {
  if (controller.active) controller.active.close = !controller.active.close;
  updateStory();
});
element('#trigger-motion').addEventListener('click', () => {
  const actor = controller.active?.hero;
  if (!actor) return;
  const name = assets[actor.kit].animations[0];
  if (name) actor.model.animation.play(name, { loop: actor.kit !== 'pavilion' });
});
element('#recolor-selection').addEventListener('click', () => {
  const selected = controller.selected;
  if (!selected) return;
  const color = ['#c5d7b1', '#dcb797', '#a6cdd5', '#c5b1d6'][colorIndex++ % 4]!;
  const material = selected.kit === 'canopy' ? 'Foliage' : selected.kit === 'coral' ? 'Coral' : selected.kit === 'terrain' ? 'Ground' : 'Shell';
  selected.model.materials.set(material, { color });
  toast(`${selected.label}: only this instance's finish changed.`);
});
element('#clear-cache').addEventListener('click', () => {
  const result = controller.clearCache();
  toast(`Released ${result.representations.entries + result.bytes.entries + result.manifests.entries} idle entries. Active objects remain available.`);
  updateMetrics();
});
element('#rapid-browse').addEventListener('click', () => {
  if (tourTimer) { stopTour(); return; }
  goTo(0);
  let next = 1;
  element('#rapid-browse').innerHTML = 'Stop rapid browsing <span>600 ms / scene</span>';
  tourTimer = setInterval(() => {
    if (next >= stories.length) { stopTour(); toast('30 scenes visited. Inspect received bytes, cancelled requests and retained scenes.'); return; }
    goTo(next++);
  }, 600);
});
element('#compare-loading').addEventListener('click', () => { void compare(); });
const closeComparison = () => { benchmarkAbort?.abort(); dialog.close(); };
element('#close-comparison').addEventListener('click', closeComparison);
element('#finish-comparison').addEventListener('click', closeComparison);
dialog.addEventListener('cancel', () => benchmarkAbort?.abort());
element('#download-comparison').addEventListener('click', () => { if (lastBenchmark) exportJson(lastBenchmark, 'stream3d-comparison.json'); });
element('#export-session').addEventListener('click', () => exportJson({ schema: 'stream3d-session/1', profile, mode, snapshot: controller.snapshot(), samples: controller.history, notes: ['Response.body payload, not wire bytes.', 'Estimated managed residency; sampled at 250 ms.', 'Frame intervals from the last 180 visible-page requestAnimationFrame callbacks.'] }, 'stream3d-session.json'));
window.addEventListener('scroll', fromScroll, { passive: true });
window.addEventListener('resize', fromScroll);
document.addEventListener('visibilitychange', () => controller?.frames.reset());
window.addEventListener('keydown', event => {
  if (dialog.open || ['INPUT', 'SELECT', 'BUTTON', 'TEXTAREA'].includes((event.target as HTMLElement)?.tagName)) return;
  if (event.key === 'ArrowDown' || event.key === 'PageDown') { event.preventDefault(); goTo(activeIndex + 1, true); }
  if (event.key === 'ArrowUp' || event.key === 'PageUp') { event.preventDefault(); goTo(activeIndex - 1, true); }
});

async function start(): Promise<void> {
  try {
    const response = await fetch('/__stream3d_lab/status', { signal: AbortSignal.timeout(1500) });
    controlled = response.ok && (await response.json() as { enabled?: boolean }).enabled === true;
  } catch { controlled = false; }
  if (!controlled) profile = 'native';
  for (const control of document.querySelectorAll<HTMLButtonElement | HTMLSelectElement>('button, select')) control.disabled = false;
  element<HTMLButtonElement>('#download-comparison').disabled = true;
  element<HTMLSelectElement>('#network-profile').disabled = !controlled;
  element<HTMLButtonElement>('#compare-loading').disabled = !controlled;
  text('#network-note', controlled ? 'Real HTTP body pacing · shared bandwidth across requests. Changing profiles starts a fresh cache session.' : 'Direct delivery. Controlled network comparisons require npm run dev or npm run preview.');
  restart();
  goTo(activeIndex);
  const animate = (timestamp: number) => {
    if (disposed) return;
    if (!benchmarkAbort) controller.tick(timestamp);
    frame = requestAnimationFrame(animate);
  };
  frame = requestAnimationFrame(animate);
  const timer = setInterval(updateMetrics, 250);
  Object.assign(window, { __stream3dShowcase: {
    get app() { return controller.app; }, get controller() { return controller; },
    get activeIndex() { return activeIndex; }, get controlled() { return controlled; },
    get lastBenchmark() { return lastBenchmark; }, stories, assets,
    goTo, snapshot: () => controller.snapshot(), compare,
  } });
  window.addEventListener('pagehide', event => {
    if (event.persisted) return;
    disposed = true;
    benchmarkAbort?.abort();
    stopTour();
    if (toastTimer) clearTimeout(toastTimer);
    clearInterval(timer);
    cancelAnimationFrame(frame);
    controller.destroy();
  });
}

void start().catch(error => {
  element('#world-loading').hidden = false;
  text('#loading-title', 'The 3D renderer could not start');
  text('#loading-detail', error instanceof Error ? error.message : String(error));
});
