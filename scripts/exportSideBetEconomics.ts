import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
const source = readFileSync(join(__dirname, 'utils/sideBetEconomics.ts'), 'utf8').replace(/\r\n/g, '\n');
const destination = join(__dirname, '../../frontend/lib/side-bet/economics-core.ts');
if (process.argv.includes('--check')) {
  if (readFileSync(destination, 'utf8').replace(/\r\n/g, '\n') !== source)
    throw new Error('Stale frontend economics core');
} else writeFileSync(destination, source);
const manifest = JSON.stringify({ sha256: createHash('sha256').update(source).digest('hex') }, null, 2) + '\n';
for (const path of [
  join(__dirname, '../docs/side-bet-economics-core.json'),
  join(__dirname, '../../frontend/lib/side-bet/economics-core.json'),
]) {
  if (process.argv.includes('--check')) {
    if (readFileSync(path, 'utf8').replace(/\r\n/g, '\n') !== manifest) throw new Error('Stale economics fingerprint');
  } else writeFileSync(path, manifest);
}
