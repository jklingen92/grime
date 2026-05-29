import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        'workers-panel': 'frontend/src/workers-panel.jsx',
        'entity-detail': 'frontend/src/entity-detail.jsx',
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: '[name]-[hash].js',
      },
    },
    outDir: 'grime/static/grime',
    emptyOutDir: false,
  },
});
