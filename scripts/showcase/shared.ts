import {
  BoxGeometry, BufferAttribute, BufferGeometry, CatmullRomCurve3, Color, CylinderGeometry,
  DoubleSide, Group, Matrix4, Mesh, MeshStandardMaterial, Quaternion, TubeGeometry,
  Vector3,
} from 'three';
import type { Material, Object3D } from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export type TextureKind = 'ceramic' | 'wood' | 'metal' | 'bark' | 'leaf' | 'ground' | 'coral' | 'lens';
export interface Surface {
  material: MeshStandardMaterial;
  texture?: TextureKind;
}
export interface Motion {
  name: string;
  node: Object3D;
  times: number[];
  rotations: [number, number, number, number][];
}
export interface Kit {
  name: string;
  title: string;
  description: string;
  root: Group;
  surfaces: Surface[];
  motions: Motion[];
}

export const TAU = Math.PI * 2;

export function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = Math.imul(state ^ state >>> 15, 1 | state);
    value ^= value + Math.imul(value ^ value >>> 7, 61 | value);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

export function surface(name: string, color: number, roughness: number, metalness = 0, texture?: TextureKind, emissive?: number): Surface {
  const material = new MeshStandardMaterial({ color, roughness, metalness, side: DoubleSide });
  material.name = name;
  if (emissive !== undefined) material.emissive = new Color(emissive);
  return { material, texture };
}

export function glass(name = 'Glass', color = 0xa5e5dc): Surface {
  const result = surface(name, color, 0.16, 0.12, 'lens');
  result.material.transparent = true;
  result.material.opacity = 0.26;
  return result;
}

export function group(name: string, parent?: Object3D, position: [number, number, number] = [0, 0, 0]): Group {
  const result = new Group();
  result.name = name;
  result.position.fromArray(position);
  parent?.add(result);
  return result;
}

export function mesh(name: string, geometry: BufferGeometry, material: Material, parent?: Object3D, position: [number, number, number] = [0, 0, 0]): Mesh {
  const result = new Mesh(geometry, material);
  result.name = name;
  result.position.fromArray(position);
  parent?.add(result);
  return result;
}

export function box(name: string, dimensions: [number, number, number], material: Material, parent: Object3D, position: [number, number, number]): Mesh {
  return mesh(name, new BoxGeometry(...dimensions), material, parent, position);
}

export function cylinder(name: string, top: number, bottom: number, height: number, material: Material, parent: Object3D, position: [number, number, number], radial = 32): Mesh {
  return mesh(name, new CylinderGeometry(top, bottom, height, radial, 1), material, parent, position);
}

export function parametric(columns: number, rows: number, point: (u: number, v: number) => [number, number, number]): BufferGeometry {
  const positions = new Float32Array((columns + 1) * (rows + 1) * 3);
  const uvs = new Float32Array((columns + 1) * (rows + 1) * 2);
  const indices = new Uint32Array(columns * rows * 6);
  let vertex = 0;
  let uv = 0;
  for (let y = 0; y <= rows; y++) {
    for (let x = 0; x <= columns; x++) {
      positions.set(point(x / columns, y / rows), vertex);
      uvs[uv++] = x / columns;
      uvs[uv++] = y / rows;
      vertex += 3;
    }
  }
  let index = 0;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < columns; x++) {
      const a = y * (columns + 1) + x;
      const b = a + 1;
      const c = a + columns + 1;
      const d = c + 1;
      indices.set([a, c, b, b, c, d], index);
      index += 6;
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new BufferAttribute(uvs, 2));
  geometry.setIndex(new BufferAttribute(indices, 1));
  geometry.computeVertexNormals();
  return geometry;
}

export function tube(points: [number, number, number][], radius: number, segments = 48, sides = 12): TubeGeometry {
  return new TubeGeometry(new CatmullRomCurve3(points.map(point => new Vector3(...point))), segments, radius, sides, false);
}

export function taperedBranch(points: [number, number, number][], radius: number, segments = 48, sides = 16): BufferGeometry {
  const curve = new CatmullRomCurve3(points.map(point => new Vector3(...point)));
  const frames = curve.computeFrenetFrames(segments, false);
  return parametric(sides, segments, (u, v) => {
    const index = Math.min(segments, Math.round(v * segments));
    const p = curve.getPointAt(v);
    const r = radius * (1 - v * 0.87) * (1 + 0.055 * Math.sin(u * TAU * 7 + v * 14));
    p.addScaledVector(frames.normals[index]!, Math.cos(u * TAU) * r);
    p.addScaledVector(frames.binormals[index]!, Math.sin(u * TAU) * r);
    return [p.x, p.y, p.z];
  });
}

export function combine(geometries: BufferGeometry[]): BufferGeometry {
  if (!geometries.length) throw new Error('Cannot combine an empty geometry collection');
  const combined = mergeGeometries(geometries, false);
  if (!combined) throw new Error('Showcase geometry attributes do not match');
  for (const geometry of geometries) geometry.dispose();
  return combined;
}

export function transform(geometry: BufferGeometry, position: Vector3, rotation: Quaternion, scale = new Vector3(1, 1, 1)): BufferGeometry {
  return geometry.applyMatrix4(new Matrix4().compose(position, rotation, scale));
}

export function rotationMotion(name: string, node: Object3D, times: number[], angles: [number, number, number][]): Motion {
  const x = new Vector3(1, 0, 0);
  const y = new Vector3(0, 1, 0);
  const z = new Vector3(0, 0, 1);
  return {
    name, node, times,
    rotations: angles.map(([a, b, c]) => {
      const quaternion = new Quaternion().setFromAxisAngle(x, a)
        .multiply(new Quaternion().setFromAxisAngle(y, b))
        .multiply(new Quaternion().setFromAxisAngle(z, c));
      return quaternion.toArray();
    }),
  };
}
