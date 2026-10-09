import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/** Unit tests: `src/**\/*.spec.ts` (pure logic, guards, filters). No database. */
export default defineConfig({
  // SWC (not esbuild) so decorators + emitDecoratorMetadata work like in the Nest build.
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['src/**/*.spec.ts'],
    environment: 'node',
    setupFiles: ['./test/setup/unit.ts'],
    restoreMocks: true,
  },
});
