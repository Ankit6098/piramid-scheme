import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/** Web unit tests: pure helpers and hooks' logic (`src/**\/*.test.ts`), no DOM. */
export default defineConfig({
  resolve: {
    // Same alias as tsconfig `paths`.
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
