#!/usr/bin/env node
import { compileAsset } from './index.js';

const USAGE = 'Usage: stream3d compile <input.glb|input.gltf> --out <directory>';

async function main(args: string[]): Promise<void> {
  if (!args.length || args.includes('--help') || args.includes('-h')) {
    process.stdout.write(`${USAGE}\n\nCompiles three progressive, independently renderable GLB representations and a static JSON manifest.\n`);
    return;
  }
  const [command, input, outFlag, outDir, ...extra] = args;
  if (command !== 'compile' || !input || outFlag !== '--out' || !outDir || extra.length) throw new Error(USAGE);
  const result = await compileAsset(input, { outDir });
  process.stdout.write(`${result.manifestPath}\n`);
  for (const level of result.manifest.levels) {
    process.stdout.write(`  ${level.id}: ${level.triangles.toLocaleString('en-US')} triangles, ${(level.byteLength / 1024).toFixed(1)} KiB transfer, ${(level.estimatedGpuBytes / 1024 / 1024).toFixed(1)} MiB estimated GPU\n`);
  }
  if (result.cached) process.stdout.write('Reused verified compiled assets.\n');
}

main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
