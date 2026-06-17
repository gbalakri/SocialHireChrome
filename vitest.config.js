import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Default to node; DOM-dependent files opt in with a
    // `// @vitest-environment jsdom` comment at the top of the test file.
    environment: 'node',
    setupFiles: ['./test/setup.js'],
    include: ['test/**/*.test.js'],
  },
});
