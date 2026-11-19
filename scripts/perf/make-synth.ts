#!/usr/bin/env node
/** Clone a legacy measurement copy into a fixed-seed synthetic Task tree.
 * Current database roots are unsupported, as in the original tool. Runs and placements are not multiplied.
 * Usage: node scripts/perf/make-synth.ts <source-copy> <dest> <N>
 */
import assert from 'node:assert/strict';
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SeededRandom } from './seeded-random.ts';

function writable(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return;
  chmodSync(path, stat.mode | 0o200);
  if (stat.isDirectory()) for (const name of readdirSync(path)) writable(join(path, name));
}

function headerSet(text: string, key: string, value: string): string {
  return text.replace(new RegExp(`^${key}: .*$`, 'm'), () => `${key}: ${value}`);
}

export function makeSynth(source: string, destination: string, total: number): void {
  const random = new SeededRandom(131);
  cpSync(source, destination, { recursive: true, verbatimSymlinks: true });
  writable(destination);
  for (const name of ['connection.json', 'push.json']) rmSync(join(destination, '.alpacawork', name), { force: true });
  const real = readdirSync(source).filter(name => /^T[1-9][0-9]*$/.test(name)).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  const docs = new Map(real.map(id => [id, readFileSync(join(source, id, 'index.md'), 'utf8').replace(/\r\n?/g, '\n')]));
  assert(real.length > 0, 'source has no legacy Task folders');
  const heavy = real.reduce((largest, id) => Array.from(docs.get(id)!).length > Array.from(docs.get(largest)!).length ? id : largest);
  const count = total - real.length, first = 1001;
  assert(Number(real.at(-1)!.slice(1)) < first, 'synthetic IDs start at T1001');
  const ids = Array.from({ length: Math.max(0, count) }, (_, i) => `T${first + i}`);
  const parent = new Map<string, string | null>();
  const chain = 30, wide = total <= 1000 ? 300 : 1000;
  assert(count >= chain + 1 + wide, 'not enough synthetic Tasks for the deep and wide trees');
  for (let i = 0; i < chain; i++) parent.set(ids[i], i === 0 ? null : ids[i - 1]);
  parent.set(ids[chain], null);
  for (let i = chain + 1; i < chain + 1 + wide; i++) parent.set(ids[i], ids[chain]);
  const openParents: [string, number][] = [];
  for (let i = chain + 1 + wide; i < count; i++) {
    const id = ids[i];
    if (!openParents.length || random.random() < 0.02) parent.set(id, null);
    else {
      const slot = random.range(Math.max(0, openParents.length - 40), openParents.length);
      const [candidate, left] = openParents[slot];
      parent.set(id, candidate);
      if (left <= 1) openParents.splice(slot, 1);
      else openParents[slot] = [candidate, left - 1];
    }
    let depth = 1, ancestor = parent.get(id)!;
    while (ancestor !== null) { depth++; ancestor = parent.get(ancestor)!; }
    if (depth < 12) openParents.push([id, random.range(2, 11)]);
  }
  for (const [index, id] of ids.entries()) {
    const original = index % 20 === 0 ? heavy : real[index % real.length];
    const text = docs.get(original)!, boundary = text.indexOf('\n---\n');
    let head = boundary < 0 ? text : text.slice(0, boundary);
    const rest = boundary < 0 ? '' : text.slice(boundary);
    head = headerSet(head, 'id', id);
    head = headerSet(head, 'parentId', parent.get(id) ?? 'null');
    const title = head.match(/^title: (.*)$/m)![1].replace(/^"+|"+$/g, '').replaceAll('"', "'");
    head = headerSet(head, 'title', `"Synthetic ${id} (copy of ${original}): ${Array.from(title).slice(0, 60).join('')}"`);
    mkdirSync(join(destination, id));
    writeFileSync(join(destination, id, 'index.md'), head + rest);
    const files = join(source, original, 'files');
    if (index % 10 === 0 && existsSync(files) && statSync(files).isDirectory())
      cpSync(files, join(destination, id, 'files'), { recursive: true, verbatimSymlinks: true });
  }
  console.log(`${destination}: ${real.length} real + ${count} synthetic = ${total}`);
}

if (import.meta.main) {
  const [source, destination, count] = process.argv.slice(2);
  if (!source || !destination || !/^[-+]?\d+$/.test(count ?? '')) throw new Error('Usage: node scripts/perf/make-synth.ts <source-copy> <dest> <N>');
  makeSynth(source, destination, Number(count));
}
