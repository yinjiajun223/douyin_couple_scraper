import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/*.integration.test.ts',
      '**/*.e2e.spec.ts',
    ],
  },
});
