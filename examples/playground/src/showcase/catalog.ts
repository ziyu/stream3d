import pavilion from '../../assets/showcase/pavilion.glb?asset';
import reactor from '../../assets/showcase/reactor.glb?asset';
import canopy from '../../assets/showcase/canopy.glb?asset';
import terrain from '../../assets/showcase/terrain.glb?asset';
import coral from '../../assets/showcase/coral.glb?asset';
import luminaire from '../../assets/showcase/luminaire.glb?asset';

export const assets = { pavilion, reactor, canopy, terrain, coral, luminaire };
export type Kit = keyof typeof assets;
export type Position = [number, number, number];
export interface ActorSpec {
  kit: Kit;
  position: Position;
  scale?: number;
  rotation?: number;
  color?: string;
  hero?: boolean;
}
export interface Story {
  index: number;
  title: string;
  collection: string;
  description: string;
  accent: string;
  sky: string;
  ground: string;
  actors: ActorSpec[];
  yaw: number;
  night: boolean;
}

const titles = [
  'The Glasshouse', 'Reactor District', 'Tidal Archive', 'After Hours', 'Canopy Exchange', 'Resonance Valley',
  'The Winter Room', 'Copper Circuit', 'Coral Observatory', 'Midnight Market', 'Fern Assembly', 'The Listening Field',
  'Emerald Pavilion', 'Magnetic Gardens', 'The Blue Collection', 'Lantern Quarter', 'An Open Conservatory', 'Signal & Stone',
  'Botanical Commons', 'The Energy Court', 'Reef Research', 'Nocturne Village', 'A Forest of Rooms', 'The Resonant Garden',
  'Architecture of Air', 'Coil Laboratory', 'Museum of Tides', 'The Last Light', 'Living Infrastructure', 'A Place to Return',
];
const collections = ['ARCHITECTURE / BOTANICAL', 'ENGINEERING / KINETIC', 'NATURE / ORGANIC', 'ARCHITECTURE / NIGHT', 'NATURE / SHARED SYSTEMS', 'ART / GENERATIVE'];
const descriptions = [
  'A vaulted pavilion, layered planting and a path of glass lanterns. Open the doors and move closer to the details.',
  'Copper coils turn inside a field of machines. Repeated assemblies share their geometry and textures across the entire collection.',
  'Branching coral, folded fans and a winding landscape. Explore the silhouettes first; surface detail arrives as you stay.',
  'A small district after sunset. Architectural modules become a new place through layout, light and independent material edits.',
  'A conservatory built from a shared botanical kit. Many visible objects, a small set of reusable asset representations.',
  'Mechanical sculptures in a planted landscape. A continuous feed of composed scenes, with bounded scene ownership.',
];
const palettes = ['#b8dfab', '#edb987', '#97dbe1', '#c7b0ed', '#e0db9b', '#e3afbb'];

function ring(kit: Kit, count: number, radius: number, offset: number, scale: number, color?: string): ActorSpec[] {
  return Array.from({ length: count }, (_, i) => {
    const a = offset + i / count * Math.PI * 2;
    return { kit, position: [Math.cos(a) * radius, 0, Math.sin(a) * radius], rotation: -a, scale, color };
  });
}

export const stories: Story[] = titles.map((title, index) => {
  const theme = index % 6;
  const variation = Math.floor(index / 6);
  const offset = variation * 0.27;
  const actors: ActorSpec[] = [{ kit: 'terrain', position: [0, -0.2, 0], scale: 1.15 }];
  if (theme === 0 || theme === 4) {
    actors.push({ kit: 'pavilion', position: [0, 0, -1], scale: 0.82, rotation: offset, hero: true });
    actors.push(...ring('canopy', theme === 4 ? 10 : 7, 7.3, offset, 0.7));
    actors.push(...ring('luminaire', 6, 5.5, 0.3 + offset, 0.7));
    actors.push(...ring('coral', theme === 4 ? 5 : 3, 3.9, offset + 0.7, 0.4, '#c4b495'));
    actors.push({ kit: 'reactor', position: [0, 0, 5], scale: 0.38 });
  } else if (theme === 1) {
    actors.push({ kit: 'reactor', position: [0, 0, 0], scale: 1.2, hero: true });
    actors.push(...ring('reactor', 4, 5, offset, 0.65));
    actors.push({ kit: 'pavilion', position: [0, 0, -7], scale: 0.55 });
    actors.push(...ring('luminaire', 8, 7.6, offset + 0.2, 0.8));
    actors.push(...ring('canopy', 3, 9, offset, 0.45));
  } else if (theme === 2) {
    actors.push({ kit: 'coral', position: [0, 0, 0], scale: 1.9, hero: true, color: '#e4c6b2' });
    actors.push(...ring('coral', 9, 5.3, offset, 0.7, '#c193a6'));
    actors.push(...ring('luminaire', 6, 7.8, offset, 0.6));
    actors.push(...ring('canopy', 3, 8.9, offset + 0.3, 0.55, '#78aaab'));
    actors.push({ kit: 'reactor', position: [-5.5, 0, -4], scale: 0.55 });
  } else if (theme === 3) {
    actors.push({ kit: 'pavilion', position: [0, 0, 0], scale: 0.72, hero: true });
    actors.push({ kit: 'pavilion', position: [-6.5, 0, -6], scale: 0.48, rotation: 0.3 });
    actors.push({ kit: 'pavilion', position: [6.5, 0, -6], scale: 0.48, rotation: -0.3 });
    actors.push(...ring('luminaire', 10, 7.7, offset, 0.85));
    actors.push(...ring('canopy', 5, 9, offset + 0.2, 0.6));
    actors.push({ kit: 'reactor', position: [0, 0, 6], scale: 0.5 });
  } else {
    actors.push({ kit: 'reactor', position: [0, 0, 0], scale: 1.35, hero: true });
    actors.push(...ring('coral', 6, 4.7, offset, 0.7));
    actors.push(...ring('canopy', 6, 8, offset + 0.2, 0.72));
    actors.push(...ring('luminaire', 8, 6.2, offset, 0.7));
    actors.push({ kit: 'pavilion', position: [0, 0, -7.6], scale: 0.45 });
  }
  return {
    index, title, collection: collections[theme]!, description: descriptions[theme]!, actors,
    accent: palettes[theme]!, sky: theme === 3 ? '#0a101b' : theme === 2 ? '#152d36' : '#172825',
    ground: theme === 3 ? '#243343' : theme === 2 ? '#658994' : '#8d9a82',
    yaw: 0.65 + offset, night: theme === 3,
  };
});
