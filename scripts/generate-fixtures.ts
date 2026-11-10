/** Original, deterministic demo assets; no downloads or third-party asset licenses. */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { Document, NodeIO } from '@gltf-transform/core';
import { SphereGeometry, TorusKnotGeometry, type BufferGeometry } from 'three';
import sharp from 'sharp';

const output = fileURLToPath(new URL('../examples/playground/assets/', import.meta.url));
await mkdir(output, { recursive: true });

function texturePixels(seed: number): Uint8Array {
  const size = 1024;
  const pixels = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      const wave = Math.sin(u * 43 + Math.sin(v * 19 + seed) * 3);
      const lines = Math.pow(Math.abs(Math.sin((u * 17 + v * 9) * Math.PI)), 14);
      const grain = ((x * 73 + y * 151 + (x * y) % 193 + seed * 89) % 37) / 37;
      const index = (y * size + x) * 4;
      pixels[index] = 172 + wave * 28 + lines * 38 + grain * 12;
      pixels[index + 1] = 179 + wave * 24 + lines * 35 + grain * 10;
      pixels[index + 2] = 187 + wave * 20 + lines * 33 + grain * 9;
      pixels[index + 3] = 255;
    }
  }
  return pixels;
}

function bloomGeometry(): BufferGeometry {
  const geometry = new SphereGeometry(1, 192, 128);
  const positions = geometry.getAttribute('position');
  for (let i = 0; i < positions.count; i++) {
    const x = positions.getX(i);
    const y = positions.getY(i);
    const z = positions.getZ(i);
    const theta = Math.atan2(z, x);
    const phi = Math.acos(Math.max(-1, Math.min(1, y)));
    const radius = 1 + 0.23 * Math.sin(theta * 7 + phi * 3) * Math.pow(Math.sin(phi), 2);
    positions.setXYZ(i, x * radius, y * radius, z * radius);
  }
  geometry.computeVertexNormals();
  return geometry;
}

const shapes = [
  { name: 'orbit', geometry: new TorusKnotGeometry(0.85, 0.27, 320, 64, 2, 3), color: [0.43, 0.88, 0.77, 1] },
  { name: 'bloom', geometry: bloomGeometry(), color: [0.94, 0.62, 0.42, 1] },
  { name: 'helix', geometry: new TorusKnotGeometry(0.85, 0.19, 384, 64, 3, 5), color: [0.63, 0.64, 0.96, 1] },
] as const;

for (let i = 0; i < shapes.length; i++) {
  const shape = shapes[i]!;
  const document = new Document();
  const buffer = document.createBuffer('geometry');
  const geometry = shape.geometry;
  const accessor = (name: string, type: 'SCALAR' | 'VEC2' | 'VEC3' | 'VEC4', values: Float32Array<ArrayBuffer> | Uint32Array<ArrayBuffer>) =>
    document.createAccessor(name).setType(type).setArray(values).setBuffer(buffer);
  const texture = document.createTexture('Surface')
    .setImage(await sharp(texturePixels(i + 1), { raw: { width: 1024, height: 1024, channels: 4 } }).png().toBuffer())
    .setMimeType('image/png');
  const material = document.createMaterial('Body')
    .setBaseColorFactor([...shape.color])
    .setBaseColorTexture(texture)
    .setMetallicFactor(0.28)
    .setRoughnessFactor(0.32);
  const primitive = document.createPrimitive()
    .setAttribute('POSITION', accessor('positions', 'VEC3', new Float32Array(geometry.getAttribute('position').array)))
    .setAttribute('NORMAL', accessor('normals', 'VEC3', new Float32Array(geometry.getAttribute('normal').array)))
    .setAttribute('TEXCOORD_0', accessor('uvs', 'VEC2', new Float32Array(geometry.getAttribute('uv').array)))
    .setIndices(accessor('indices', 'SCALAR', new Uint32Array(geometry.getIndex()!.array)))
    .setMaterial(material);
  const body = document.createNode('Body').setMesh(document.createMesh('Sculpture').addPrimitive(primitive));
  document.createScene('Sculpture').addChild(body);

  const idleTimes = accessor('idle-times', 'SCALAR', new Float32Array([0, 3, 6, 9, 12]));
  const rotations = accessor('idle-rotations', 'VEC4', new Float32Array([
    0, 0, 0, 1,
    0, Math.SQRT1_2, 0, Math.SQRT1_2,
    0, 1, 0, 0,
    0, Math.SQRT1_2, 0, -Math.SQRT1_2,
    0, 0, 0, -1,
  ]));
  const sampler = document.createAnimationSampler('Idle').setInput(idleTimes).setOutput(rotations).setInterpolation('LINEAR');
  document.createAnimation('Idle').addSampler(sampler).addChannel(
    document.createAnimationChannel().setTargetNode(body).setTargetPath('rotation').setSampler(sampler),
  );
  const pulseSampler = document.createAnimationSampler('Pulse')
    .setInput(accessor('pulse-times', 'SCALAR', new Float32Array([0, 0.7, 1.4])))
    .setOutput(accessor('pulse-scales', 'VEC3', new Float32Array([1, 1, 1, 1.13, 0.9, 1.13, 1, 1, 1])));
  document.createAnimation('Pulse').addSampler(pulseSampler).addChannel(
    document.createAnimationChannel().setTargetNode(body).setTargetPath('scale').setSampler(pulseSampler),
  );

  const bytes = await new NodeIO().writeBinary(document);
  const destination = join(output, `${shape.name}.glb`);
  const previous = await readFile(destination).catch(() => undefined);
  if (!previous || !previous.equals(Buffer.from(bytes))) {
    await writeFile(destination, bytes);
  }
  geometry.dispose();
  console.log(`${shape.name}: ${(bytes.byteLength / 1024).toFixed(0)} KiB original, ${primitive.getIndices()!.getCount() / 3} triangles`);
}
