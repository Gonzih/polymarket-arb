import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 15000,
    coverage: { reporter: ['text', 'json'] },
    include: ['src/__tests__/**/*.test.ts'],
    exclude: ['node_modules', 'src/__tests__/integration/**'],
  },
});
