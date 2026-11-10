import './style.css';
import { createApp } from 'stream3d';
import { AmbientLight, Color, DirectionalLight, GridHelper, HemisphereLight } from 'three';
import orbit from '../assets/orbit.glb?asset';
import bloom from '../assets/bloom.glb?asset';
import helix from '../assets/helix.glb?asset';

const canvas = document.querySelector<HTMLCanvasElement>('#scene-canvas')!;
const app = createApp({ canvas, controls: true, budgets: { gpuBytes: 16 * 1024 ** 2, cacheBytes: 32 * 1024 ** 2 } });
const assets = [orbit, bloom, helix];
const names = ['Orbit', 'Bloom', 'Helix'];
const grids: GridHelper[] = [];
const scenes = assets.map(asset => {
  const scene = app.createScene();
  scene.root.background = new Color('#10191c');
  scene.root.add(new HemisphereLight('#dfebe6', '#34493f', 2.2));
  scene.root.add(new AmbientLight('#e7fff4', 0.5));
  const key = new DirectionalLight('#e5fff3', 4);
  key.position.set(3, 4, 4);
  const rim = new DirectionalLight('#b0bee5', 3);
  rim.position.set(-4, 1, -2);
  scene.root.add(key, rim);
  const grid = new GridHelper(20, 40, '#2c4940', '#1d302b');
  grid.position.y = -1.65;
  scene.root.add(grid);
  grids.push(grid);
  scene.camera.position.set(0, 0.6, 5);
  scene.camera.lookAt(0, 0, 0);
  return scene;
});
const models = scenes.map((scene, index) => {
  const model = scene.addModel(assets[index]!);
  model.animation.play('Idle');
  model.on('click', () => model.animation.play('Pulse'));
  return model;
});
const extras: typeof models = [];
let activeIndex = 0;
let presentation = 0;
let colorIndex = 0;
let pulsing = false;
const colors = ['#f3d49c', '#b5ebdb', '#c2b2f3', '#eaacaa'];
const text = (selector: string, value: string) => {
  document.querySelector(selector)!.textContent = value;
};
const loading = document.querySelector<HTMLElement>('#loading-message')!;

function present(index: number) {
  activeIndex = index;
  pulsing = models[index]!.animation.current === 'Pulse';
  const generation = ++presentation;
  loading.hidden = false;
  loading.textContent = 'Preparing the first representation…';
  app.present(scenes[index]!);
  app.controls?.target.set(0, 0, 0);
  text('#asset-name', `${String(index + 1).padStart(2, '0')} / ${names[index]!.toUpperCase()}`);
  text('#animate', pulsing ? 'Play idle' : 'Play pulse');
  const distance = scenes[index]!.camera.position.z;
  document.querySelector<HTMLInputElement>('#distance')!.value = String(distance);
  text('#distance-output', distance.toFixed(1));
  document.querySelectorAll<HTMLButtonElement>('[data-scene]').forEach(button => {
    const selected = Number(button.dataset.scene) === index;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
  void models[index]!.ready('interactive').then(() => {
    if (generation === presentation) loading.hidden = true;
  }).catch(error => {
    if (generation === presentation) loading.textContent = error instanceof Error ? error.message : String(error);
  });
}

document.querySelectorAll<HTMLButtonElement>('[data-scene]').forEach(button => {
  button.addEventListener('click', () => present(Number(button.dataset.scene)));
});
document.querySelector<HTMLInputElement>('#distance')!.addEventListener('input', event => {
  const distance = Number((event.target as HTMLInputElement).value);
  const camera = scenes[activeIndex]!.camera;
  camera.position.set(0, distance * 0.12, distance);
  camera.lookAt(0, 0, 0);
  app.controls?.update();
  text('#distance-output', distance.toFixed(1));
});
document.querySelector<HTMLSelectElement>('#budget')!.addEventListener('change', event => {
  app.setBudgets({ gpuBytes: Number((event.target as HTMLSelectElement).value) * 1024 ** 2 });
});
document.querySelector('#add-instances')!.addEventListener('click', () => {
  for (let i = 0; i < 5; i++) {
    const model = scenes[activeIndex]!.addModel(assets[activeIndex]!);
    model.position.set((i - 2) * 0.8, -1.12, 1.1 - Math.floor(extras.length / 5) * 1.4);
    model.scale.setScalar(0.24);
    model.animation.play(i % 2 ? 'Idle' : 'Pulse');
    extras.push(model);
  }
});
document.querySelector('#reset')!.addEventListener('click', () => {
  for (const model of extras.splice(0)) model.destroy();
});
document.querySelector('#recolor')!.addEventListener('click', () => {
  models[activeIndex]!.materials.set('Body', { color: colors[colorIndex++ % colors.length]! });
});
document.querySelector('#animate')!.addEventListener('click', () => {
  pulsing = !pulsing;
  models[activeIndex]!.animation.play(pulsing ? 'Pulse' : 'Idle');
  text('#animate', pulsing ? 'Play idle' : 'Play pulse');
});

const diagnosticsTimer = setInterval(() => {
  const snapshot = app.diagnostics();
  text('#metric-memory', `${(snapshot.estimatedGpuBytes / 1024 ** 2).toFixed(1)} MiB`);
  text('#metric-hits', snapshot.resources.hits.toLocaleString());
  text('#metric-instances', snapshot.activeModels.toLocaleString());
  text('#metric-triangles', snapshot.render.triangles.toLocaleString());
  const first = snapshot.levels.find(level => level.visible && level.level);
  text('#current-level', first ? `${first.level!.toUpperCase()}${first.pending ? ` → ${first.pending.toUpperCase()}` : ''}` : 'Preparing first representation');
  text('#diagnostics', JSON.stringify(snapshot, null, 2));
  if (snapshot.activeModels > 0 && first) loading.hidden = true;
}, 200);

present(0);

// The demo exposes real runtime state for browser regression tests and exploration.
Object.assign(window, { __stream3d: { app, scenes, models, extras, assets, present } });
window.addEventListener('pagehide', event => {
  if (event.persisted) return;
  clearInterval(diagnosticsTimer);
  for (const grid of grids) {
    grid.geometry.dispose();
    for (const material of Array.isArray(grid.material) ? grid.material : [grid.material]) material.dispose();
  }
  app.destroy();
});
