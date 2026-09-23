import { defineConfig } from 'vitest/config';

// Vitest owns its own config so its bundled Vite version cannot clash with the
// Vite used for the production build.
export default defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    globals: true,
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
