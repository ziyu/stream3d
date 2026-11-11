import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { stream3d } from '@stream3d/vite';
import { networkLab } from './network-lab.js';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [networkLab(), stream3d()],
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
