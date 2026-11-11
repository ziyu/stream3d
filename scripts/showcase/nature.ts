import { Euler, Quaternion, SphereGeometry, Vector3 } from 'three';
import type { BufferGeometry } from 'three';
import {
  TAU, combine, group, mesh, parametric, random, rotationMotion, surface, taperedBranch,
  transform, tube,
} from './shared.js';
import type { Kit } from './shared.js';
import { terrainHeight } from './textures.js';

function leafGeometry(length: number, width: number, bend: number): BufferGeometry {
  return parametric(8, 10, (u, v) => {
    const across = (u - 0.5) * 2;
    const outline = Math.sin(Math.PI * v) ** 0.72;
    return [across * width * outline, Math.abs(across) * 0.035 * outline + Math.sin(v * Math.PI) * bend, v * length];
  });
}

export function canopy(): Kit {
  const rng = random(23819);
  const root = group('Silverleaf_Canopy');
  root.scale.set(0.82, 1, 0.82);
  const bark = surface('Bark', 0xb5a184, 0.93, 0, 'bark');
  const foliage = surface('Foliage', 0x6aa965, 0.84, 0, 'leaf');
  const light = surface('FoliageLight', 0xc0d694, 0.76, 0, 'leaf');
  mesh('Twisting_Trunk', taperedBranch([[0, 0.02, 0], [0.06, 1.1, -0.1], [-0.12, 2.4, 0.05], [0.1, 3.8, 0]], 0.22, 96, 24), bark.material, root);
  for (let i = 0; i < 8; i++) {
    const angle = i / 8 * TAU;
    const x = Math.cos(angle);
    const z = Math.sin(angle);
    mesh(`Buttress_Root_${i}`, taperedBranch([[0, 0.48, 0], [x * 0.2, 0.16, z * 0.2], [x * 0.48, 0.025, z * 0.48]], 0.1, 32, 12), bark.material, root);
  }
  const windGroups = [group('Windward_Crown', root, [0, 2.25, 0]), group('Leeward_Crown', root, [0, 2.25, 0])];
  const motions: Kit['motions'] = windGroups.map((node, index) => {
    const amplitude = index ? -0.035 : 0.045;
    return rotationMotion('Sway', node, [0, 1.5, 3, 4.5, 6], [[0, 0, 0], [amplitude * 0.4, 0, amplitude], [0, 0, 0], [-amplitude * 0.4, 0, -amplitude], [0, 0, 0]]);
  });
  for (let crown = 0; crown < 10; crown++) {
    const angle = crown / 10 * TAU + rng() * 0.25;
    const branch = group(`Living_Crown_${crown}`, windGroups[crown % 2], [0, crown % 3 * 0.28, 0]);
    const end = new Vector3(Math.cos(angle) * 1.03, 1.1 + rng() * 0.56, Math.sin(angle) * 1.03);
    mesh(`Primary_Bough_${crown}`, taperedBranch([[0, 0, 0], [end.x * 0.52, 0.44, end.z * 0.52], end.toArray()], 0.085, 40, 14), bark.material, branch);
    for (let twig = 0; twig < 2; twig++) {
      const a = angle + (twig ? 0.55 : -0.55);
      mesh(`Twig_${crown}_${twig}`, taperedBranch([
        [end.x * 0.48, end.y * 0.6, end.z * 0.48],
        [Math.cos(a) * 0.8, end.y * 0.9, Math.sin(a) * 0.8],
        [Math.cos(a) * 1.23, end.y + 0.2, Math.sin(a) * 1.23],
      ], 0.034, 24, 10), bark.material, branch);
    }
    const leaves: BufferGeometry[][] = [[], []];
    for (let index = 0; index < 50; index++) {
      const azimuth = rng() * TAU;
      const radius = Math.sqrt(rng()) * 0.58;
      const position = new Vector3(end.x + Math.cos(azimuth) * radius, end.y + (rng() - 0.25) * 0.64, end.z + Math.sin(azimuth) * radius);
      const rotation = new Quaternion().setFromEuler(new Euler((rng() - 0.5) * 1.2, rng() * TAU, (rng() - 0.5) * 0.8));
      const leaf = leafGeometry(0.3 + rng() * 0.22, 0.09 + rng() * 0.045, 0.03 + rng() * 0.06);
      leaves[index % 2]!.push(transform(leaf, position, rotation));
    }
    mesh(`Dark_Leaf_Spray_${crown}`, combine(leaves[0]!), foliage.material, branch);
    mesh(`Silver_Leaf_Spray_${crown}`, combine(leaves[1]!), light.material, branch);
  }
  return { name: 'canopy', title: 'Silverleaf canopy', description: 'Buttressed twisting trunk, ten boughs, twenty twigs and five hundred veined leaves in two wind-driven crown assemblies.', root, surfaces: [bark, foliage, light], motions };
}

export function terrain(): Kit {
  const rng = random(90172);
  const root = group('River_Garden_Terrain');
  const ground = surface('Ground', 0xdce0c4, 0.98, 0, 'ground');
  const stone = surface('Stone', 0xa5b1a4, 0.91, 0, 'ceramic');
  const water = surface('Water', 0x58aead, 0.2, 0.28, 'lens');
  water.material.transparent = true;
  water.material.opacity = 0.83;
  const foliage = surface('Foliage', 0x8cab5e, 0.95, 0, 'leaf');
  mesh('Sculpted_Ground', parametric(256, 256, (u, v) => {
    const x = u * 20 - 10;
    const z = v * 20 - 10;
    return [x, terrainHeight(x, z), z];
  }), ground.material, root);
  for (let side = 0; side < 4; side++) {
    mesh(`Ground_Edge_${side}`, parametric(256, 1, (u, v) => {
      const x = side % 2 === 0 ? u * 20 - 10 : (side === 1 ? 10 : -10);
      const z = side % 2 === 0 ? (side === 0 ? -10 : 10) : u * 20 - 10;
      return [x, v * terrainHeight(x, z), z];
    }), ground.material, root);
  }
  mesh('Meandering_Stream', parametric(16, 256, (u, v) => {
    const z = v * 20 - 10;
    const x = Math.sin(z * 0.31) * 2.1 + 0.4 + (u - 0.5) * 1.8;
    return [x, 0.185 + Math.sin(v * 180 + u * 14) * 0.003, z];
  }), water.material, root);
  const rocks: BufferGeometry[] = [];
  for (let i = 0; i < 18; i++) {
    const x = (rng() - 0.5) * 18;
    const z = (rng() - 0.5) * 18;
    const radius = 0.15 + rng() * 0.37;
    const geometry = new SphereGeometry(1, 36, 24);
    const positions = geometry.getAttribute('position');
    for (let p = 0; p < positions.count; p++) {
      const px = positions.getX(p);
      const py = positions.getY(p);
      const pz = positions.getZ(p);
      const facets = 1 + 0.1 * Math.sin(px * 14 + i) * Math.cos(pz * 13) + 0.07 * Math.sin(py * 16);
      positions.setXYZ(p, px * facets, py * facets, pz * facets);
    }
    geometry.computeVertexNormals();
    rocks.push(transform(geometry, new Vector3(x, terrainHeight(x, z) + radius * 0.17, z), new Quaternion().setFromEuler(new Euler(rng(), rng() * TAU, rng())), new Vector3(radius * 1.2, radius * 0.6, radius)));
  }
  const boulders = combine(rocks);
  const rockPositions = boulders.getAttribute('position');
  // Buried rock bottoms should not extend the tile's authored bounds below its ground plane.
  for (let index = 0; index < rockPositions.count; index++) {
    if (rockPositions.getY(index) < 0.02) rockPositions.setY(index, 0.02);
  }
  boulders.computeVertexNormals();
  mesh('Weathered_Boulders', boulders, stone.material, root);
  const grasses: BufferGeometry[] = [];
  for (let i = 0; i < 850; i++) {
    const x = (rng() - 0.5) * 19;
    const z = (rng() - 0.5) * 19;
    const height = terrainHeight(x, z);
    if (height < 0.25) continue;
    const h = 0.1 + rng() * 0.23;
    const blade = parametric(1, 3, (u, v) => [(u - 0.5) * 0.035 * (1 - v), v * h, v * v * 0.09]);
    grasses.push(transform(blade, new Vector3(x, height, z), new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), rng() * TAU)));
  }
  mesh('Meadow_Grass', combine(grasses), foliage.material, root);
  return { name: 'terrain', title: 'River garden', description: 'Twenty-metre sculpted landscape with a meandering stream, footpath texture, eighteen weathered boulders and meadow grass.', root, surfaces: [ground, stone, water, foliage], motions: [] };
}

export function coral(): Kit {
  const rng = random(71832);
  const root = group('Coral_Nursery');
  const coralSurface = surface('Coral', 0xf1a78b, 0.8, 0, 'coral');
  const pale = surface('CoralLight', 0x9ed4c8, 0.76, 0, 'coral');
  const stone = surface('Stone', 0xb5b6a5, 0.96, 0, 'ceramic');
  const base = mesh('Reef_Foundation', new SphereGeometry(1, 48, 24), stone.material, root, [0, 0.16, 0]);
  base.scale.set(1.3, 0.18, 1.15);
  const motions: Kit['motions'] = [];
  for (let colony = 0; colony < 7; colony++) {
    const angle = colony / 7 * TAU;
    const branch = group(`Staghorn_Colony_${colony}`, root, [Math.cos(angle) * 0.5, 0.2, Math.sin(angle) * 0.4]);
    const height = 1.3 + rng() * 0.65;
    const pieces: BufferGeometry[] = [];
    pieces.push(taperedBranch([[0, 0, 0], [0.08, height * 0.5, 0], [Math.cos(angle) * 0.16, height, Math.sin(angle) * 0.16]], 0.1, 40, 12));
    for (let arm = 0; arm < 5; arm++) {
      const a = angle + arm / 5 * TAU;
      const startY = 0.4 + arm * 0.17;
      const end = new Vector3(Math.cos(a) * (0.43 + rng() * 0.17), startY + 0.5 + rng() * 0.28, Math.sin(a) * (0.43 + rng() * 0.17));
      pieces.push(taperedBranch([[0.03, startY, 0], [end.x * 0.7, end.y - 0.19, end.z * 0.7], end.toArray()], 0.055, 24, 10));
      for (const fork of [-1, 1]) {
        const tip = end.clone().add(new Vector3(Math.cos(a + fork * 0.6) * 0.22, 0.27 + rng() * 0.15, Math.sin(a + fork * 0.6) * 0.22));
        pieces.push(taperedBranch([[end.x * 0.8, end.y - 0.1, end.z * 0.8], end.toArray(), tip.toArray()], 0.025, 16, 8));
      }
    }
    mesh(`Porous_Branches_${colony}`, combine(pieces), colony % 2 ? pale.material : coralSurface.material, branch);
    const amplitude = 0.016 + colony % 3 * 0.008;
    motions.push(rotationMotion('Sway', branch, [0, 2, 4, 6, 8], [[0, 0, 0], [amplitude, 0, amplitude], [0, 0, 0], [-amplitude, 0, -amplitude], [0, 0, 0]]));
  }
  for (let fan = 0; fan < 2; fan++) {
    const support = group(`Sea_Fan_${fan}`, root, [fan ? 0.42 : -0.48, 0.23, -0.55]);
    support.rotation.y = fan ? 0.4 : -0.35;
    const fanSurface = parametric(112, 64, (u, v) => {
      const angle = (u - 0.5) * 2.3;
      const radius = 0.14 + v * 1.37;
      const edge = 1 + 0.045 * Math.sin(u * Math.PI * 32) * v * v;
      return [Math.sin(angle) * radius * edge, Math.cos(angle) * radius * edge, Math.sin(u * 56 + v * 8) * v * 0.055];
    });
    mesh(`Ruffled_Fan_Tissue_${fan}`, fanSurface, fan ? pale.material : coralSurface.material, support);
    const veins: BufferGeometry[] = [];
    for (let vein = 0; vein < 13; vein++) {
      const angle = (vein / 12 - 0.5) * 2.3;
      veins.push(tube([[0, 0, 0.012], [Math.sin(angle) * 0.65, Math.cos(angle) * 0.65, 0.02], [Math.sin(angle) * 1.42, Math.cos(angle) * 1.42, 0.025]], 0.013, 32, 8));
    }
    mesh(`Fan_Skeleton_${fan}`, combine(veins), stone.material, support);
  }
  const brain = new SphereGeometry(0.42, 112, 80);
  const positions = brain.getAttribute('position');
  for (let index = 0; index < positions.count; index++) {
    const x = positions.getX(index);
    const y = positions.getY(index);
    const z = positions.getZ(index);
    const ridges = 1 + 0.075 * Math.sin(x * 65 + Math.sin(z * 22) * 3) * Math.cos(y * 19);
    positions.setXYZ(index, x * ridges, y * ridges * 0.8, z * ridges);
  }
  brain.computeVertexNormals();
  mesh('Maze_Coral', brain, pale.material, root, [0.55, 0.42, 0.56]);
  return { name: 'coral', title: 'Coral nursery', description: 'Seven articulated staghorn colonies, two ruffled sea fans with branching skeletons, and sculpted maze coral.', root, surfaces: [coralSurface, pale, stone], motions };
}
