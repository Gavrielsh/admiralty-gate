// Downloads MaxMind's public TEST databases (tiny, synthetic) for the GeoIP tests. They are not committed:
// the files are licensed separately from this repository. Tests that need them are skipped when they are absent.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'data');
mkdirSync(out, { recursive: true });
for (const name of ['GeoIP2-City-Test.mmdb', 'GeoLite2-ASN-Test.mmdb']) {
  const res = await fetch(`https://raw.githubusercontent.com/maxmind/MaxMind-DB/main/test-data/${name}`);
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  writeFileSync(join(out, name), Buffer.from(await res.arrayBuffer()));
  console.log(`saved ${name}`);
}
