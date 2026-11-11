import {
  BoxGeometry, CylinderGeometry, LatheGeometry, Quaternion, SphereGeometry, TorusGeometry,
  Vector2, Vector3,
} from 'three';
import {
  TAU, box, combine, cylinder, glass, group, mesh, parametric, rotationMotion, surface,
  transform, tube,
} from './shared.js';
import type { Kit } from './shared.js';

export function pavilion(): Kit {
  const root = group('Tidal_Pavilion');
  const shell = surface('Shell', 0xe9eee1, 0.43, 0.12, 'ceramic');
  const wood = surface('Wood', 0xe6c798, 0.68, 0, 'wood');
  const metal = surface('Metal', 0x32524f, 0.3, 0.8, 'metal');
  const glazing = glass();
  const stone = surface('Stone', 0xa5b6ab, 0.86, 0, 'ceramic');
  const light = surface('Light', 0xffe6af, 0.25, 0, undefined, 0xffd88a);

  box('Foundation', [7.6, 0.3, 7.6], stone.material, root, [0, 0.15, 0]);
  box('Deck', [7.3, 0.15, 7.3], wood.material, root, [0, 0.375, 0]);
  for (let step = 0; step < 3; step++) {
    box(`Entry_Step_${step}`, [3.3, 0.12, 0.45], stone.material, root, [0, 0.06 + step * 0.12, 4.1 - step * 0.34]);
  }
  const roofHeight = (x: number, z: number) => 3.7 + 0.54 * (Math.abs(x) / 4) ** 2 + 0.16 * Math.cos(z * Math.PI / 4);
  for (const side of [-1, 1]) {
    const roof = parametric(144, 128, (u, v) => {
      const x = side * (0.04 + u * 3.98);
      const z = v * 8.1 - 4.05;
      const rib = Math.cos(v * Math.PI * 96) * 0.025 * Math.sin(u * Math.PI);
      return [x, roofHeight(x, z) + rib, z];
    });
    mesh(side < 0 ? 'West_Ceramic_Roof' : 'East_Ceramic_Roof', roof, shell.material, root);
    const edge = tube(Array.from({ length: 33 }, (_, i) => {
      const z = i / 32 * 8.1 - 4.05;
      return [side * 4.02, roofHeight(4.02, z), z] as [number, number, number];
    }), 0.065, 96, 14);
    mesh(`Roof_Edge_${side}`, edge, metal.material, root);
  }
  for (let rib = 0; rib < 9; rib++) {
    const z = -3.55 + rib * 0.89;
    const beam = tube(Array.from({ length: 33 }, (_, i) => {
      const x = i / 32 * 7.8 - 3.9;
      return [x, roofHeight(x, z) - 0.095, z] as [number, number, number];
    }), 0.07, 72, 14);
    mesh(`Laminated_Arch_${rib}`, beam, wood.material, root);
  }
  for (const x of [-3.25, 3.25]) {
    for (const z of [-3.2, 0, 3.2]) {
      cylinder(`Timber_Column_${x}_${z}`, 0.11, 0.16, 3.38, wood.material, root, [x, 2.05, z], 40);
      cylinder(`Column_Foot_${x}_${z}`, 0.19, 0.22, 0.23, metal.material, root, [x, 0.57, z], 32);
      box(`Column_Light_${x}_${z}`, [0.055, 1.2, 0.025], light.material, root, [x, 2.4, z + 0.13]);
    }
  }
  // Side screens retain individual slats, plus three glazed panels with visible frames.
  for (const x of [-3.45, 3.45]) {
    for (let slat = 0; slat < 34; slat++) {
      const z = slat / 33 * 6.75 - 3.375;
      box(`Louver_${x}_${slat}`, [0.065, 2.65, 0.085], wood.material, root, [x, 1.8, z]);
    }
    for (let panel = 0; panel < 3; panel++) {
      box(`Side_Glass_${x}_${panel}`, [0.025, 2.45, 2.05], glazing.material, root, [x * 0.97, 1.8, panel * 2.18 - 2.18]);
    }
  }
  box('Rear_Beam', [6.75, 0.11, 0.12], metal.material, root, [0, 3.2, -3.4]);
  box('Rear_Seat', [5.6, 0.18, 0.65], wood.material, root, [0, 0.96, -2.8]);
  for (const x of [-2.3, 0, 2.3]) box(`Bench_Support_${x}`, [0.2, 0.43, 0.5], stone.material, root, [x, 0.665, -2.8]);
  cylinder('Circular_Table_Base', 0.2, 0.42, 0.68, stone.material, root, [0, 0.79, -0.55], 48);
  cylinder('Circular_Table_Top', 0.83, 0.83, 0.12, wood.material, root, [0, 1.19, -0.55], 96);
  const motions: Kit['motions'] = [];
  for (const side of [-1, 1]) {
    const hinge = group(side < 0 ? 'West_Door_Hinge' : 'East_Door_Hinge', root, [side * 3.15, 0.45, 3.3]);
    const midpoint = -side * 1.5;
    box(`Entry_Glass_${side}`, [2.94, 2.56, 0.035], glazing.material, hinge, [midpoint, 1.35, 0]);
    for (const y of [0.06, 2.65]) box(`Door_Rail_${side}_${y}`, [3.05, 0.075, 0.065], metal.material, hinge, [midpoint, y, 0]);
    for (const x of [-side * 0.04, -side * 2.96]) box(`Door_Stile_${side}_${x}`, [0.075, 2.6, 0.065], metal.material, hinge, [x, 1.35, 0]);
    cylinder(`Door_Handle_${side}`, 0.025, 0.025, 0.42, metal.material, hinge, [-side * 2.73, 1.4, 0.1], 20);
    motions.push(rotationMotion('Open', hinge, [0, 1.7, 3.8, 5.5, 7], [0, 1.18, 1.18, 0, 0].map(a => [0, side * a, 0])));
  }
  return { name: 'pavilion', title: 'Tidal pavilion', description: 'Curved ceramic roof, nine laminated timber arches, louver screens, furniture and operable glass doors.', root, surfaces: [shell, wood, metal, glazing, stone, light], motions };
}

export function reactor(): Kit {
  const root = group('Flux_Reactor');
  const metal = surface('Metal', 0x718e94, 0.28, 0.85, 'metal');
  const shell = surface('Shell', 0xbfd2cb, 0.37, 0.22, 'ceramic');
  const glazing = glass('Glass', 0x5edfd7);
  const energy = surface('Energy', 0x72f5ce, 0.2, 0.2, undefined, 0x31cbb4);
  const copper = surface('Copper', 0xeeae75, 0.32, 0.85, 'metal');
  cylinder('Footing', 1.12, 1.35, 0.25, metal.material, root, [0, 0.125, 0], 96);
  cylinder('Base_Casing', 0.94, 1.1, 0.48, shell.material, root, [0, 0.49, 0], 96);
  cylinder('Upper_Cap', 0.9, 1.02, 0.24, shell.material, root, [0, 3.72, 0], 96);
  const profile = Array.from({ length: 129 }, (_, i) => {
    const t = i / 128;
    return new Vector2(0.63 + 0.045 * Math.sin(t * Math.PI * 48) + 0.06 * Math.sin(t * Math.PI), 0.65 + t * 2.8);
  });
  mesh('Corrugated_Pressure_Vessel', new LatheGeometry(profile, 128), metal.material, root);
  const rotor = group('Magnetic_Rotor', root, [0, 2.1, 0]);
  for (let ring = 0; ring < 3; ring++) {
    const radius = 1.1 + (ring === 1 ? 0.14 : 0);
    const coil = mesh(`Magnetic_Coil_${ring}`, new TorusGeometry(radius, 0.095 + ring * 0.006, 32, 192), copper.material, rotor, [0, (ring - 1) * 0.82, 0]);
    coil.rotation.x = Math.PI / 2;
    const trim = mesh(`Coil_Insulator_${ring}`, new TorusGeometry(radius, 0.025, 12, 128), energy.material, rotor, [0, (ring - 1) * 0.82 + 0.11, 0]);
    trim.rotation.x = Math.PI / 2;
  }
  for (let brace = 0; brace < 6; brace++) {
    const angle = brace / 6 * TAU;
    const x = Math.cos(angle) * 1.02;
    const z = Math.sin(angle) * 1.02;
    const support = box(`Rotor_Brace_${brace}`, [0.12, 1.9, 0.17], metal.material, rotor, [x, 0, z]);
    support.rotation.y = -angle;
  }
  for (let helix = 0; helix < 2; helix++) {
    const points = Array.from({ length: 129 }, (_, i) => {
      const t = i / 128;
      const angle = t * TAU * 4 + helix * Math.PI;
      return [Math.cos(angle) * 0.8, 0.73 + t * 2.72, Math.sin(angle) * 0.8] as [number, number, number];
    });
    mesh(`Helical_Cooling_Line_${helix}`, tube(points, 0.042, 384, 16), helix ? energy.material : copper.material, root);
  }
  const core = mesh('Reaction_Core', new SphereGeometry(0.48, 96, 64), energy.material, root, [0, 2.1, 0]);
  core.scale.y = 2.3;
  mesh('Containment_Glass', new CylinderGeometry(0.89, 0.89, 2.72, 96, 12, true), glazing.material, root, [0, 2.08, 0]);
  const boltGeometry = new CylinderGeometry(0.045, 0.045, 0.05, 8);
  for (let bolt = 0; bolt < 24; bolt++) {
    const angle = bolt / 24 * TAU;
    mesh(`Base_Bolt_${bolt}`, boltGeometry, copper.material, root, [Math.cos(angle) * 1.13, 0.27, Math.sin(angle) * 1.13]);
  }
  for (let port = 0; port < 4; port++) {
    const angle = port / 4 * TAU;
    const instrument = group(`Instrument_${port}`, root, [Math.cos(angle) * 0.98, 0.62, Math.sin(angle) * 0.98]);
    instrument.rotation.y = -angle + Math.PI / 2;
    box(`Readout_Housing_${port}`, [0.28, 0.3, 0.12], metal.material, instrument, [0, 0, 0]);
    box(`Readout_Display_${port}`, [0.21, 0.19, 0.015], energy.material, instrument, [0, 0.02, 0.07]);
  }
  const motions = [rotationMotion('Spin', rotor, [0, 3, 6, 9, 12], [0, 1, 2, 3, 4].map(i => [0, i * Math.PI / 2, 0]))];
  return { name: 'reactor', title: 'Flux reactor', description: 'Ribbed pressure vessel, three copper magnetic coils, double helical coolant lines and rotating braced rotor.', root, surfaces: [metal, shell, glazing, energy, copper], motions };
}

export function luminaire(): Kit {
  const root = group('Helio_Luminaire');
  const metal = surface('Metal', 0x3e5b5b, 0.3, 0.78, 'metal');
  const shell = surface('Shell', 0xc8d4c1, 0.4, 0.2, 'ceramic');
  const glazing = glass('Glass', 0xffe8bc);
  const light = surface('Light', 0xffedc3, 0.2, 0, 'lens', 0xffd38b);
  const copper = surface('Copper', 0xe9b67e, 0.33, 0.8, 'metal');
  cylinder('Anchored_Base', 0.2, 0.28, 0.15, metal.material, root, [0, 0.075, 0], 64);
  const stemProfile = Array.from({ length: 129 }, (_, i) => {
    const t = i / 128;
    const collar = 0.014 * Math.max(0, Math.sin(t * Math.PI * 36));
    return new Vector2(0.06 + 0.025 * (1 - t) + collar, 0.15 + t * 2.45);
  });
  mesh('Ribbed_Stem', new LatheGeometry(stemProfile, 64), metal.material, root);
  const conduit = Array.from({ length: 97 }, (_, i) => {
    const t = i / 96;
    return [Math.cos(t * TAU * 8) * 0.1, 0.2 + t * 2.2, Math.sin(t * TAU * 8) * 0.1] as [number, number, number];
  });
  mesh('Copper_Conduit', tube(conduit, 0.012, 256, 10), copper.material, root);
  const head = group('Tracking_Head', root, [0, 2.65, 0]);
  const lamp = group('Angled_Lamp', head);
  lamp.rotation.z = -0.28;
  const reflector = parametric(96, 64, (u, v) => {
    const angle = u * TAU;
    const radius = 0.08 + v * 0.24;
    const flute = Math.sin(angle * 16) * 0.01 * v;
    return [Math.cos(angle) * (radius + flute), 0.23 - v * v * 0.21, Math.sin(angle) * (radius + flute)];
  });
  mesh('Fluted_Reflector', reflector, shell.material, lamp);
  const rim = mesh('Lens_Rim', new TorusGeometry(0.32, 0.018, 16, 96), copper.material, lamp, [0, 0.02, 0]);
  rim.rotation.x = Math.PI / 2;
  const lens = mesh('Prismatic_Lens', new SphereGeometry(0.305, 80, 48), glazing.material, lamp, [0, 0.035, 0]);
  lens.scale.y = 0.3;
  const bulb = mesh('Light_Emitter', new SphereGeometry(0.17, 48, 32), light.material, lamp, [0, 0.085, 0]);
  bulb.scale.y = 0.5;
  const fins = [];
  for (let fin = 0; fin < 16; fin++) {
    const angle = fin / 16 * TAU;
    const geometry = parametric(20, 8, (u, v) => [u * 0.2 + 0.08, 0.16 + Math.sin(u * Math.PI) * 0.08, (v - 0.5) * 0.013]);
    fins.push(transform(geometry, new Vector3(), new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), angle)));
  }
  mesh('Radial_Heat_Sink', combine(fins), metal.material, lamp);
  box('Asymmetric_Control_Module', [0.12, 0.22, 0.12], shell.material, head, [0.15, -0.13, 0]);
  const motions = [rotationMotion('Sweep', head, [0, 2, 4, 6, 8], [[0, -0.65, -0.05], [0, 0, 0.08], [0, 0.65, -0.05], [0, 0, -0.1], [0, -0.65, -0.05]])];
  return { name: 'luminaire', title: 'Helio luminaire', description: 'Ribbed mast, spiral copper conduit, tracking head, sixteen cooling fins and prismatic glass lens.', root, surfaces: [metal, shell, glazing, light, copper], motions };
}
