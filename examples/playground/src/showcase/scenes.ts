import { Color, DirectionalLight, FogExp2, HemisphereLight, Vector3 } from 'three';
import type { AssetManifest, ManagedModel, ManagedScene, StreamApp } from 'stream3d';
import { assets, type Kit, type Story } from './catalog.js';
import type { NetworkProfileId } from './network-profiles.js';

export type LoadingMode = 'progressive' | 'whole';
export interface AssetPolicy {
  mode: LoadingMode;
  profile: NetworkProfileId;
  session: string;
  controlled: boolean;
  forceHighest?: boolean;
}
export interface Actor { kit: Kit; model: ManagedModel; label: string }
export interface SceneBundle {
  story: Story;
  scene: ManagedScene;
  actors: Actor[];
  hero: Actor;
  essential: ManagedModel[];
  yaw: number;
  distance: number;
  target: Vector3;
  heroTarget: Vector3;
  lighting: HemisphereLight;
  close: boolean;
  destroy(): void;
}

export function createAssetSet(policy: AssetPolicy): Record<Kit, AssetManifest> {
  return Object.fromEntries(Object.entries(assets).map(([kit, asset]) => {
    const sourceLevels = policy.mode === 'whole' ? [asset.levels.at(-1)!] : asset.levels;
    return [kit, {
      ...asset,
      levels: sourceLevels.map(level => {
        const url = new URL(level.url, document.baseURI);
        if (policy.controlled) {
          url.searchParams.set('labProfile', policy.profile);
          url.searchParams.set('labSession', policy.session);
        }
        return { ...level, url: url.href, minScreenCoverage: policy.mode === 'whole' || policy.forceHighest ? 0 : level.minScreenCoverage };
      }),
    }];
  })) as Record<Kit, AssetManifest>;
}

export function buildScene(app: StreamApp, story: Story, assetSet: Record<Kit, AssetManifest>, onSelect?: (actor: Actor) => void): SceneBundle {
  const scene = app.createScene();
  scene.root.background = new Color(story.sky);
  scene.root.fog = new FogExp2(story.sky, 0.012);
  const lighting = new HemisphereLight(story.night ? '#9eaacb' : '#e6f4d6', '#354c43', story.night ? 1.9 : 2.6);
  const sun = new DirectionalLight(story.night ? '#b3bbed' : '#fff0cf', story.night ? 2.1 : 3.2);
  sun.position.set(8, 16, 9);
  const rim = new DirectionalLight('#7ec6d2', story.night ? 2.6 : 1.3);
  rim.position.set(-9, 7, -8);
  scene.root.add(lighting, sun, rim);
  const actors = story.actors.map((spec, index): Actor => {
    const model = scene.addModel(assetSet[spec.kit]);
    model.position.fromArray(spec.position);
    model.scale.setScalar(spec.scale ?? 1);
    model.rotation.y = spec.rotation ?? 0;
    const animation = spec.kit === 'reactor' ? 'Spin' : spec.kit === 'canopy' || spec.kit === 'coral' ? 'Sway' : spec.kit === 'luminaire' ? 'Sweep' : null;
    if (animation) model.animation.play(animation, { timeScale: 0.5 + index % 3 * 0.15 });
    if (spec.color) model.materials.set(spec.kit === 'canopy' ? 'Foliage' : 'Coral', { color: spec.color });
    if (spec.kit === 'terrain') model.materials.set('Ground', { color: story.ground });
    if (spec.kit === 'pavilion') model.materials.set('Shell', { color: story.accent });
    if (spec.kit === 'luminaire') model.materials.set('Light', { emissive: story.accent, emissiveIntensity: story.night ? 3 : 1.4 });
    const actor = { kit: spec.kit, model, label: `${spec.kit[0]!.toUpperCase()}${spec.kit.slice(1)} ${index + 1}` };
    model.on('click', () => onSelect?.(actor));
    return actor;
  });
  const heroIndex = story.actors.findIndex(actor => actor.hero);
  const hero = actors[Math.max(0, heroIndex)]!;
  const bundle: SceneBundle = {
    story, scene, actors, hero, essential: [actors[0]!.model, hero.model],
    yaw: story.yaw, distance: 29, target: new Vector3(0, 1.1, 0),
    heroTarget: hero.model.position.clone().add(new Vector3(0, hero.kit === 'pavilion' ? 2 : 1.8, 0)),
    lighting, close: false,
    destroy() { scene.destroy(); },
  };
  updateCamera(bundle, 1, true);
  return bundle;
}

export function updateCamera(bundle: SceneBundle, aspect: number, immediate = false): void {
  const distance = bundle.close ? (bundle.hero.kit === 'pavilion' ? 12 : 9) : 29;
  const adjusted = distance * (aspect < 0.8 ? 1.65 : aspect < 1.15 ? 1.18 : 1);
  bundle.distance += (adjusted - bundle.distance) * (immediate ? 1 : 0.12);
  const target = bundle.close ? bundle.heroTarget : new Vector3(0, 1.1, 0);
  bundle.target.lerp(target, immediate ? 1 : 0.12);
  const elevation = bundle.close ? 0.3 : 0.54;
  const horizontal = bundle.distance * Math.cos(elevation);
  bundle.scene.camera.position.set(
    bundle.target.x + Math.sin(bundle.yaw) * horizontal,
    bundle.target.y + Math.sin(elevation) * bundle.distance,
    bundle.target.z + Math.cos(bundle.yaw) * horizontal,
  );
  bundle.scene.camera.lookAt(bundle.target);
}

export function afterPaint(): Promise<void> {
  return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}
