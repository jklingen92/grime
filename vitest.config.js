import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Separate from vite.config.js so the production build config stays untouched.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['frontend/tests/**/*.test.{js,jsx}'],
    setupFiles: ['frontend/tests/setup.js'],
    globals: true,
  },
});
