import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        'workers-panel': 'frontend/src/workers-panel.jsx',
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
