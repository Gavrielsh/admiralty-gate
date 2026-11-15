import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Tests run against the core's source, so they do not depend on a prior `npm run build`.
export default defineConfig({
  resolve: { alias: { 'admiralty-gate': fileURLToPath(new URL('../../packages/core/src/index.ts', import.meta.url)) } },
  test: { testTimeout: 15000 },
});
