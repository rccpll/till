import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'node',
    include: ['tests/node/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
  },
});
