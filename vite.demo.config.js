// Build the browser-only demo (dashboard + viewer) for jklingen92.github.io/grime/.
//
//   python manage.py export_demo --page A --page B   # -> demo-data/
//   npm run build:demo                               # -> dist-demo/
//   npx vite preview -c vite.demo.config.js          # open <url>/grime/
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));

const git = (args) => execSync(`git ${args}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

function demoVersion() {
  let sha = 'unknown';
  try {
    sha = git('rev-parse --short HEAD');
    if (git('status --porcelain')) sha += '-dirty';
  } catch {
    // Not a git checkout, or git isn't installed.
  }
  const { version } = JSON.parse(readFileSync(here('package.json'), 'utf8'));
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  return `v${version}+${sha} · ${stamp}`;
}

export default defineConfig({
  plugins: [react()],
  // Build stamp for the banner (frontend/demo/version.js), e.g. "v0.1.0+05eab66-dirty · 2026-11-24 14:05" (UTC).
  define: { __DEMO_VERSION__: JSON.stringify(demoVersion()) },
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
