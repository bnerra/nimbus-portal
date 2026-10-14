import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Runs once before all tests: makes sure the schema and seed data exist.
    globalSetup: ['test/global-setup.ts'],
    // Integration tests share one database, so run test files one at a time.
    fileParallelism: false,
  },
});
