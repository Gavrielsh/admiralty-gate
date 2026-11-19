#!/usr/bin/env node
/** admiralty-gate-mcp-bridge [--dashboard http://127.0.0.1:4319] [--policy file] -- <mcp server command> [args...] */
import { readFileSync } from 'node:fs';
import { runBridge } from './bridge.js';

const argv = process.argv.slice(2);
const split = argv.indexOf('--');
const flags = split < 0 ? argv : argv.slice(0, split);
const [command, ...args] = split < 0 ? [] : argv.slice(split + 1);
const flag = (name: string): string | undefined => {
  const i = flags.indexOf(`--${name}`);
  return i >= 0 ? flags[i + 1] : undefined;
};
if (!command) {
  process.stderr.write('usage: admiralty-gate-mcp-bridge [--dashboard http://127.0.0.1:4319] [--policy file] -- <mcp server command> [args...]\n');
  process.exit(1);
}
const policyFile = flag('policy');
runBridge({
  dashboard: flag('dashboard') ?? 'http://127.0.0.1:4319', command, args,
  ...(process.env.ADMIRALTY_API_KEY ? { apiKey: process.env.ADMIRALTY_API_KEY } : {}),
  ...(policyFile ? { policyJson: readFileSync(policyFile, 'utf8') } : {}),
}).then(
  code => process.exit(code),
  (e: Error) => {
    process.stderr.write(`admiralty-gate-mcp-bridge: ${e.message}\n`);
    process.exit(1);
  },
);
