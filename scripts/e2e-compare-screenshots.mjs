import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

const root = path.resolve('tmp/reports/e2e');
function collect(stage) {
  const directory = path.join(root, stage, 'results');
  if (!existsSync(directory)) throw new Error(`Run test:e2e:${stage} first`);
  const files = new Map();
  function visit(folder) {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (/^(home|chat|knowledge|needs|reports)\.png$/.test(entry.name)) files.set(path.relative(directory, file), createHash('sha256').update(readFileSync(file)).digest('hex'));
    }
  }
  visit(directory);
  if (files.size !== 10) throw new Error(`Expected 10 desktop/mobile screenshots in ${stage}, found ${files.size}`);
  return files;
}
const before = collect('before'), after = collect('after');
const comparisons = [...before].map(([file, hash]) => ({ file, status: after.get(file) === hash ? 'identical' : after.has(file) ? 'changed' : 'missing' }));
writeFileSync(path.join(root, 'screenshot-comparison.json'), JSON.stringify(comparisons, null, 2));
for (const row of comparisons) console.log(`${row.status}: ${row.file}`);
if (comparisons.some(row => row.status !== 'identical')) {
  console.error('Screenshots differ. Inspect before/after images and confirm intended changes; do not blindly replace a baseline.');
  process.exitCode = 1;
}
