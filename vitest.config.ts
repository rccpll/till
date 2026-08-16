import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['./vitest.workers.config.ts', './vitest.node.config.ts'],
  },
});
