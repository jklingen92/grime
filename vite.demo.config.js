// Build the browser-only demo (dashboard + viewer) for jklingen92.github.io/grime/.
//
//   python manage.py export_demo --page A --page B   # -> demo-data/
//   npm run build:demo                               # -> dist-demo/
//   npx vite preview -c vite.demo.config.js          # open <url>/grime/
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  plugins: [react()],
  root: here('frontend/demo'),
  base: '/grime/',
  // demo-data/ holds manifest.json and pages/<pk>/; copied verbatim to the build root.
  publicDir: here('demo-data'),
  build: {
    outDir: here('dist-demo'),
    emptyOutDir: true,
    // Demo entries load their JSON with top-level await.
    target: 'es2022',
    // index.html is the dashboard; viewer.html?page=<pk> opens one page.
    rollupOptions: {
      input: {
        index: here('frontend/demo/index.html'),
        viewer: here('frontend/demo/viewer.html'),
      },
    },
  },
});
