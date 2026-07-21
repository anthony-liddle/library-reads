import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['src/**/*.ts'],
      // types.ts is exports-only (interfaces, type aliases, JSDoc) and emits no
      // runtime code, so it has no executable behavior to cover.
      exclude: ['src/**/*.test.ts', 'src/types.ts'],
    },
  },
});
