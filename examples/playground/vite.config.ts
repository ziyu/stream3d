import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { stream3d } from '@stream3d/vite';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [stream3d()],
  server: { host: '127.0.0.1', port: 5173 },
  preview: { host: '127.0.0.1', port: 4173 },
  build: {
    outDir: '../../dist/playground',
    emptyOutDir: true,
    rolldownOptions: {
      input: {
        playground: fileURLToPath(new URL('./index.html', import.meta.url)),
        feed: fileURLToPath(new URL('./feed.html', import.meta.url)),
      },
    },
  },
});
