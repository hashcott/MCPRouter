import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    retry: 0,
    projects: [
      {
        test: {
          name: 'unit',
          include: ['packages/*/src/**/*.test.ts', 'packages/*/test/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'integration',
          include: ['packages/*/src/**/*.itest.ts', 'packages/*/test/**/*.itest.ts'],
          environment: 'node',
          testTimeout: 120_000,
          hookTimeout: 120_000,
          fileParallelism: false,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'lcov'],
      include: ['packages/*/src/**/*.ts'],
      // `main.ts` is process bootstrap: importing one starts a server or a CLI,
      // so no test imports it and counting it measures nothing.
      exclude: ['**/*.test.ts', '**/*.itest.ts', '**/dist/**', '**/main.ts'],
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 60,
        'packages/core/src/security/**': { lines: 90, branches: 85 },
        'packages/core/src/tools/**': { lines: 90, branches: 85 },
        'packages/server/src/mcp/**': { lines: 85, branches: 75 },
      },
    },
  },
});
