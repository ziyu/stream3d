import './feed.css';
import { createApp } from 'stream3d';
import { Color, DirectionalLight, HemisphereLight } from 'three';
import orbit from '../assets/orbit.glb?asset';
import bloom from '../assets/bloom.glb?asset';
import helix from '../assets/helix.glb?asset';

const canvas = document.querySelector<HTMLCanvasElement>('#feed-canvas')!;
// One app and one canvas are shared across the entire feed. The browser owns scrolling.
const app = createApp({ canvas, budgets: { gpuBytes: 16 * 1024 ** 2, cacheBytes: 32 * 1024 ** 2 } });
const names = ['Orbit', 'Bloom', 'Helix'];
const descriptions = ['A continuous knot, always in motion.', 'A sculpted surface that catches the light.', 'An intricate loop. A new perspective with every turn.'];
const assets = [orbit, bloom, helix];
const scenes = assets.map(() => {
  const scene = app.createScene();
  scene.root.background = new Color('#0b1519');
  scene.root.add(new HemisphereLight('#e5f8ef', '#3d514b', 2.5));
  const key = new DirectionalLight('#edfff4', 4);
  key.position.set(3, 4, 4);
  const rim = new DirectionalLight('#aabcef', 3);
  rim.position.set(-3, 2, -2);
  scene.root.add(key, rim);
  return scene;
});
const models = scenes.map((scene, index) => {
  const model = scene.addModel(assets[index]!);
  model.animation.play('Idle');
  return model;
});
const loading = document.querySelector<HTMLElement>('#feed-loading')!;
const text = (selector: string, value: string) => { document.querySelector(selector)!.textContent = value; };
let active = -1;
let generation = 0;
let recolors = 0;
const colors = ['#f3d49c', '#b5ebdb', '#c2b2f3', '#eaacaa'];

function show(index: number) {
  const next = Math.max(0, Math.min(models.length - 1, index));
  if (next === active) return;
  active = next;
  const token = ++generation;
  app.present(scenes[next]!);
  loading.hidden = false;
  loading.textContent = 'Preparing the first representation…';
  text('#feed-index', `OBJECT ${String(next + 1).padStart(2, '0')} / 03`);
  text('#feed-name', names[next]!);
  text('#feed-description', descriptions[next]!);
  text('#feed-animation', models[next]!.animation.current === 'Pulse' ? 'Play idle' : 'Play pulse');
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-feed-scene]')) {
    button.setAttribute('aria-current', String(Number(button.dataset.feedScene) === next));
  }
  void models[next]!.ready('interactive').then(() => {
    if (token === generation) loading.hidden = true;
  }).catch(error => {
    if (token === generation) loading.textContent = error instanceof Error ? error.message : String(error);
  });
}

function fromScroll() {
  const sections = document.querySelectorAll<HTMLElement>('.feed-page');
  const center = window.innerHeight / 2;
  let nearest = 0;
  let distance = Infinity;
  sections.forEach((section, index) => {
    const bounds = section.getBoundingClientRect();
    const candidate = Math.abs(bounds.top + bounds.height / 2 - center);
    if (candidate < distance) { distance = candidate; nearest = index; }
  });
  show(nearest);
}

function frameCamera() {
  // Keep the whole first representation in view on narrow phones.
  const distance = window.innerWidth < 600 ? 7.6 : 5.2;
  for (const scene of scenes) {
    scene.camera.position.set(0, 0.15, distance);
    scene.camera.lookAt(0, 0.15, 0);
  }
  fromScroll();
}

window.addEventListener('scroll', fromScroll, { passive: true });
window.addEventListener('resize', frameCamera);
document.querySelectorAll<HTMLButtonElement>('[data-feed-scene]').forEach(button => {
  button.addEventListener('click', () => {
    const section = document.querySelectorAll<HTMLElement>('.feed-page')[Number(button.dataset.feedScene)]!;
    section.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  });
});

// Vertical touch gestures remain native scrolling; horizontal drags rotate the stable model root.
let drag: { id: number; x: number; y: number; rotation: number; index: number } | null = null;
canvas.addEventListener('pointerdown', event => {
  if (event.button !== 0 || active < 0) return;
  drag = { id: event.pointerId, x: event.clientX, y: event.clientY, rotation: models[active]!.rotation.y, index: active };
  canvas.setPointerCapture(event.pointerId);
});
canvas.addEventListener('pointermove', event => {
  if (!drag || event.pointerId !== drag.id || active !== drag.index) return;
  const dx = event.clientX - drag.x;
  const dy = event.clientY - drag.y;
  if (Math.abs(dx) > Math.abs(dy)) models[active]!.rotation.y = drag.rotation + dx * 0.008;
});
canvas.addEventListener('pointerup', () => { drag = null; });
canvas.addEventListener('pointercancel', () => { drag = null; });
document.querySelector('#feed-color')!.addEventListener('click', () => {
  models[active]!.materials.set('Body', { color: colors[recolors++ % colors.length]! });
});
document.querySelector('#feed-animation')!.addEventListener('click', () => {
  const model = models[active]!;
  const pulse = model.animation.current !== 'Pulse';
  model.animation.play(pulse ? 'Pulse' : 'Idle');
  text('#feed-animation', pulse ? 'Play idle' : 'Play pulse');
});
const timer = setInterval(() => {
  const model = models[active];
  text('#feed-quality', model?.currentLevel != null ? model.manifest!.levels[model.currentLevel]!.id.toUpperCase() : 'PREPARING');
}, 200);

frameCamera();
Object.assign(window, { __stream3dFeed: { app, scenes, models, show } });
window.addEventListener('pagehide', event => {
  if (event.persisted) return;
  clearInterval(timer);
  app.destroy();
});
