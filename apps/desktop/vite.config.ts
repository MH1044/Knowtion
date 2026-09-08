import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'src/renderer',
  // Loaded over file:// in the packaged app, so every asset path must be relative.
  base: './',
  build: {
    outDir: '../../dist/renderer',
    emptyOutDir: true,
    target: 'chrome130',
  },
  plugins: [react()],
});
