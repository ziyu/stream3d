import { Document, NodeIO } from '@gltf-transform/core';
import sharp from 'sharp';

/** A real textured, skinned, morphing glTF; no browser or downloaded test asset is needed. */
export async function makeFixture(): Promise<Document> {
  const document = new Document();
  const buffer = document.createBuffer('Geometry').setURI('geometry.bin');
  const positions: number[] = [], normals: number[] = [], uv: number[] = [], indices: number[] = [];
  const width = 32, height = 16;
  for (let y = 0; y <= height; y++) {
    for (let x = 0; x <= width; x++) {
      const theta = x / width * Math.PI * 2;
      const phi = y / height * Math.PI;
      const position = [Math.sin(phi) * Math.cos(theta), Math.cos(phi), Math.sin(phi) * Math.sin(theta)];
      positions.push(...position);
      normals.push(...position);
      uv.push(x / width, y / height);
      if (y < height && x < width) {
        const a = y * (width + 1) + x, b = a + width + 1;
        indices.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
  }
  const vertexCount = positions.length / 3;
  const position = document.createAccessor('Position', buffer).setType('VEC3').setArray(new Float32Array(positions));
  const normal = document.createAccessor('Normal', buffer).setType('VEC3').setArray(new Float32Array(normals));
  const texcoord = document.createAccessor('UV', buffer).setType('VEC2').setArray(new Float32Array(uv));
  const index = document.createAccessor('Indices', buffer).setType('SCALAR').setArray(new Uint16Array(indices));
  const jointIndices = new Uint16Array(vertexCount * 4);
  const weights = new Float32Array(vertexCount * 4);
  for (let vertex = 0; vertex < vertexCount; vertex++) weights[vertex * 4] = 1;
  const joints = document.createAccessor('Joints', buffer).setType('VEC4').setArray(jointIndices);
  const weight = document.createAccessor('Weights', buffer).setType('VEC4').setArray(weights);
  const morph = document.createAccessor('MorphPosition', buffer).setType('VEC3').setArray(new Float32Array(positions.map((value) => value * 0.2)));

  const pixels = Buffer.alloc(512 * 512 * 3);
  for (let pixel = 0; pixel < pixels.length; pixel++) pixels[pixel] = (pixel * 37 + Math.floor(pixel / 1536) * 19) % 256;
  const png = await sharp(pixels, { raw: { width: 512, height: 512, channels: 3 } }).png().toBuffer();
  const texture = document.createTexture('Pattern').setImage(png).setMimeType('image/png').setURI('color.png');
  const material = document.createMaterial('Paint').setBaseColorTexture(texture).setMetallicFactor(0.1).setRoughnessFactor(0.6);
  const primitive = document.createPrimitive().setAttribute('POSITION', position).setAttribute('NORMAL', normal).setAttribute('TEXCOORD_0', texcoord).setAttribute('JOINTS_0', joints).setAttribute('WEIGHTS_0', weight).setIndices(index).setMaterial(material);
  primitive.addTarget(document.createPrimitiveTarget('Inflate').setAttribute('POSITION', morph));
  const mesh = document.createMesh('Sphere').addPrimitive(primitive).setWeights([0]);
  const joint = document.createNode('Joint');
  const skin = document.createSkin('Skeleton').addJoint(joint).setSkeleton(joint);
  const inverseBind = document.createAccessor('InverseBind', buffer).setType('MAT4').setArray(new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]));
  skin.setInverseBindMatrices(inverseBind);
  const node = document.createNode('Body').setMesh(mesh).setSkin(skin).setTranslation([1, 0, 0]);
  const scene = document.createScene('World').addChild(node).addChild(joint);
  document.getRoot().setDefaultScene(scene);
  const time = document.createAccessor('Time', buffer).setType('SCALAR').setArray(new Float32Array([0, 1, 2]));
  const translation = document.createAccessor('Translation', buffer).setType('VEC3').setArray(new Float32Array([1, 0, 0, 1, 0.5, 0, 1, 0, 0]));
  const sampler = document.createAnimationSampler().setInput(time).setOutput(translation).setInterpolation('LINEAR');
  const channel = document.createAnimationChannel().setTargetNode(node).setTargetPath('translation').setSampler(sampler);
  document.createAnimation('Float').addSampler(sampler).addChannel(channel);
  return document;
}

export async function writeFixture(filename: string): Promise<void> {
  await new NodeIO().write(filename, await makeFixture());
}
