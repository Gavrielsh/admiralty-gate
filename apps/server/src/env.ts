import { existsSync, readFileSync } from 'node:fs';

/** Minimal KEY=VALUE loader for .env.local. Existing process env wins; values are never logged. */
export function loadEnvFile(path: string, env: NodeJS.ProcessEnv = process.env): string[] {
  if (!existsSync(path)) return [];
  const loaded: string[] = [];
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2]!.trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (env[m[1]!] === undefined && v !== '') {
      env[m[1]!] = v;
      loaded.push(m[1]!);
    }
  }
  return loaded;
}
