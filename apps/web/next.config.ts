import type { NextConfig } from 'next';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const config: NextConfig = {
  devIndicators: false,
  agentRules: false,
  // The workspace root (where node_modules and the lockfile live) is two levels up.
  turbopack: { root: resolve(dirname(fileURLToPath(import.meta.url)), '../..') },
};
export default config;
