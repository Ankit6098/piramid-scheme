import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/**
 * Integration tests: `test/**\/*.int-spec.ts` against a real Postgres (TEST_DATABASE_URL) + Redis.
 * Files run one at a time in a single worker (they share one database and truncate it).
 * globalSetup creates the database if missing and runs `prisma migrate deploy` against it.
 */
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['test/**/*.int-spec.ts'],
    environment: 'node',
    globalSetup: ['./test/setup/global-setup.ts'],
    setupFiles: ['./test/setup/integration.ts'],
    pool: 'forks',
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
