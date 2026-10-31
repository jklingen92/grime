import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';
import react from '@vitejs/plugin-react';

// Same tests as vitest.config.js, run in real engines. WebKit stands in for Safari.
// One-time setup: npx playwright install --with-deps chromium firefox webkit
// Run: npm run test:browsers
export default defineConfig({
  plugins: [react()],
  test: {
    include: ['frontend/tests/**/*.test.{js,jsx}'],
    setupFiles: ['frontend/tests/setup.js'],
    globals: true,
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: 'chromium' }, { browser: 'firefox' }, { browser: 'webkit' }],
    },
  },
});
