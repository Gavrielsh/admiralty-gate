import type { NextConfig } from 'next';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// NEXT_PUBLIC_* settings are read from the repository's .env.local, the same file the server uses,
// so there is one place to configure both apps.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const fromRoot: Record<string, string> = {};
if (existsSync(resolve(root, '.env.local')))
  for (const line of readFileSync(resolve(root, '.env.local'), 'utf8').split('\n')) {
    const m = /^\s*(NEXT_PUBLIC_[A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && m[2] && process.env[m[1]!] === undefined) fromRoot[m[1]!] = m[2]!.replace(/^["']|["']$/g, '');
  }

const config: NextConfig = {
  env: fromRoot,
  devIndicators: false,
  agentRules: false,
  // The workspace root (where node_modules and the lockfile live) is two levels up.
  turbopack: { root: resolve(dirname(fileURLToPath(import.meta.url)), '../..') },
};
export default config;
