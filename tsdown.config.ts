import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'node22',
  treeshake: true,
  // package.json declares "type": "module", so ESM output is plain .js and .d.ts.
  // tsdown otherwise forces .mjs/.cjs when targeting node (fixedExtension default).
  fixedExtension: false,
});
