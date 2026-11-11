import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { stream3d } from '@stream3d/vite';
import { networkLab } from './network-lab.js';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [networkLab(), stream3d({
    // A feed composes many instances at once. Spend the initial asset budget on
    // silhouettes, then restore surface detail without changing the highest GLB.
    levels: [
      { id: 'preview', ratio: 0.03, textureSize: 128, minScreenCoverage: 0 },
      { id: 'standard', ratio: 0.25, textureSize: 512, minScreenCoverage: 0.25 },
      { id: 'full', ratio: 1, textureSize: 1024, minScreenCoverage: 0.65 },
    ],
  })],
  server: { host: '127.0.0.1', port: 5173 },
  preview: { host: '127.0.0.1', port: 4173 },
  build: {
    outDir: '../../dist/playground',
    emptyOutDir: true,
    rolldownOptions: {
      input: {
        playground: fileURLToPath(new URL('./index.html', import.meta.url)),
        feed: fileURLToPath(new URL('./feed.html', import.meta.url)),
        inspector: fileURLToPath(new URL('./inspector.html', import.meta.url)),
        minimal: fileURLToPath(new URL('./minimal.html', import.meta.url)),
      },
    },
  },
});
