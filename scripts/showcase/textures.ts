import sharp from 'sharp';
import type { TextureKind } from './shared.js';

export interface TextureImage { bytes: Uint8Array; size: number; }

function hash(x: number, y: number, seed: number): number {
  let value = Math.imul(x + 374761393, 668265263) ^ Math.imul(y + seed, 2246822519);
  value = Math.imul(value ^ value >>> 13, 1274126177);
  return ((value ^ value >>> 16) >>> 0) / 4294967295;
}

function smoothNoise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const tx = x - xi;
  const ty = y - yi;
  const u = tx * tx * (3 - 2 * tx);
  const v = ty * ty * (3 - 2 * ty);
  const a = hash(xi, yi, seed) * (1 - u) + hash(xi + 1, yi, seed) * u;
  const b = hash(xi, yi + 1, seed) * (1 - u) + hash(xi + 1, yi + 1, seed) * u;
  return a * (1 - v) + b * v;
}

export function terrainHeight(x: number, z: number): number {
  const large = smoothNoise((x + 10) * 0.22, (z + 10) * 0.22, 33);
  const small = smoothNoise((x + 10) * 1.3, (z + 10) * 1.3, 57);
  const riverX = Math.sin(z * 0.31) * 2.1 + 0.4;
  const river = Math.exp(-((x - riverX) ** 2) / 1.1);
  return Math.max(0.07, 0.2 + large * 0.56 + small * 0.09 - river * 0.45);
}

/** Surface detail is generated from physical motifs (grain, veins, pores, aggregate), not payload padding. */
export async function generateTexture(kind: TextureKind): Promise<TextureImage> {
  const size = kind === 'ground' || kind === 'wood' ? 2048 : 1024;
  const pixels = new Uint8Array(size * size * 3);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      const grain = hash(x, y, 101) - 0.5;
      let r = 0;
      let g = 0;
      let b = 0;
      if (kind === 'wood') {
        const warp = Math.sin(v * 19) * 0.022 + Math.sin(v * 57) * 0.004;
        const growth = Math.sin((u + warp) * 95 * Math.PI);
        const fibre = Math.sin((u + warp * 0.8) * 480 * Math.PI) * 4;
        const knots = Math.sin(Math.hypot((u - 0.63) * 4, (v - 0.35) * 0.6) * 170) * Math.exp(-Math.abs(u - 0.63) * 9);
        r = 188 + growth * 18 + grain * 15 + fibre + knots * 13;
        g = 146 + growth * 20 + grain * 13 + fibre + knots * 12;
        b = 96 + growth * 16 + grain * 10 + fibre + knots * 9;
      } else if (kind === 'metal') {
        const brush = hash(x, Math.floor(y / 3), 11) * 17 + Math.sin(v * 1900) * 4;
        const seam = (x % 256 < 3 || y % 512 < 3) ? -33 : 0;
        r = 194 + brush + grain * 8 + seam;
        g = 201 + brush + grain * 8 + seam;
        b = 208 + brush + grain * 8 + seam;
      } else if (kind === 'ceramic') {
        const mottling = smoothNoise(u * 18, v * 18, 67) * 17;
        const grout = (x % 256 < 3 || y % 256 < 3) ? -18 : 0;
        const speckle = grain > 0.47 ? -30 : grain * 12;
        r = 219 + mottling + grout + speckle;
        g = 224 + mottling + grout + speckle;
        b = 223 + mottling + grout + speckle;
      } else if (kind === 'bark') {
        const ridge = Math.sin((u + Math.sin(v * 21) * 0.012) * Math.PI * 65);
        const cracks = Math.pow(Math.max(0, ridge), 9) * 49;
        const patches = smoothNoise(u * 15, v * 9, 7) * 35;
        r = 131 + patches + grain * 31 - cracks;
        g = 108 + patches + grain * 25 - cracks;
        b = 78 + patches + grain * 20 - cracks;
      } else if (kind === 'leaf') {
        const central = Math.exp(-Math.abs(u - 0.5) * 200);
        const vein = Math.pow(Math.max(0, Math.cos((v + Math.abs(u - 0.5) * 0.8) * 75)), 28);
        const mottling = smoothNoise(u * 25, v * 25, 71) * 32;
        r = 122 + central * 58 + vein * 27 + mottling + grain * 12;
        g = 182 + central * 34 + vein * 24 + mottling + grain * 11;
        b = 92 + central * 26 + vein * 12 + mottling + grain * 9;
      } else if (kind === 'ground') {
        const worldX = u * 20 - 10;
        const worldZ = v * 20 - 10;
        const moss = smoothNoise(u * 24, v * 24, 33);
        const sand = smoothNoise(u * 170, v * 170, 91);
        const path = Math.exp(-((worldZ - Math.cos(worldX * 0.34) * 1.75) ** 2) / 0.5);
        const wet = Math.exp(-((worldX - Math.sin(worldZ * 0.31) * 2.1 - 0.4) ** 2) / 1.5);
        r = 112 + moss * 50 + path * 49 - wet * 24 + grain * 26 + sand * 12;
        g = 126 + moss * 44 + path * 30 - wet * 21 + grain * 24 + sand * 10;
        b = 86 + moss * 37 + path * 18 - wet * 11 + grain * 18 + sand * 8;
      } else if (kind === 'coral') {
        const px = u * 48;
        const py = v * 48;
        const cellX = Math.floor(px);
        const cellY = Math.floor(py);
        const dx = px - cellX - 0.5 + (hash(cellX, cellY, 5) - 0.5) * 0.3;
        const dy = py - cellY - 0.5 + (hash(cellX, cellY, 9) - 0.5) * 0.3;
        const pore = Math.exp(-(dx * dx + dy * dy) * 35);
        const rim = Math.sin(Math.hypot(dx, dy) * 23) * 8;
        r = 235 - pore * 72 + rim + grain * 14;
        g = 191 - pore * 65 + rim + grain * 11;
        b = 165 - pore * 53 + rim + grain * 10;
      } else {
        const radius = Math.hypot(u - 0.5, v - 0.5);
        const prism = Math.sin(radius * 650) * 12;
        r = 209 + prism + grain * 4;
        g = 231 + prism + grain * 4;
        b = 237 + prism + grain * 4;
      }
      const index = (y * size + x) * 3;
      pixels[index] = Math.max(0, Math.min(255, r));
      pixels[index + 1] = Math.max(0, Math.min(255, g));
      pixels[index + 2] = Math.max(0, Math.min(255, b));
    }
  }
  const bytes = await sharp(pixels, { raw: { width: size, height: size, channels: 3 } }).png({ compressionLevel: 6 }).toBuffer();
  return { bytes, size };
}
