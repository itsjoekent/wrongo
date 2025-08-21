import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 60000, // 60 seconds for integration tests
    hookTimeout: 60000, // 60 seconds for setup/teardown
    teardownTimeout: 60000,
    include: ['test/**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
  },
});
