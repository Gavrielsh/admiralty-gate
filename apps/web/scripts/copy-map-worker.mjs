// MapLibre runs its geometry work in a Web Worker loaded by URL. Bundlers do not emit that file on their own,
// so it is copied into public/ (served at /maplibre-gl-worker.mjs) before dev and build.
import { copyFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const src = join(dirname(require.resolve('maplibre-gl/package.json')), 'dist', 'maplibre-gl-worker.mjs');
const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
mkdirSync(out, { recursive: true });
copyFileSync(src, join(out, 'maplibre-gl-worker.mjs'));
