import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['test/**/*.test.ts'],
    passWithNoTests: false,
    coverage: { reporter: ['text', 'lcov'], include: ['src/**/*.ts'] }
  }
});
