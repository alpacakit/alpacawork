/**
 * The rule for reporting an estimate lives in one place every responsible reads,
 * the owner's reference of the alpacawork skill. An add-on that only some users install
 * cannot carry it, and a second copy drifts from the first.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const skills = resolve(import.meta.dirname, '../skills');
const owner = join(skills, 'alpacawork/references/owner.md');
const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true })
  .flatMap(entry => entry.isDirectory() ? files(join(dir, entry.name)) : entry.name.endsWith('.md') ? [join(dir, entry.name)] : []);

test('the owner reference shows how to report an estimate, once, as a complete command', () => {
  // Checked by the command, not by the skill's wording, so the rule around it can be reworded or translated.
  const rule = readFileSync(owner, 'utf8').split('\n').filter(line => line.includes('--estimate'));
  assert.equal(rule.length, 1, 'one line');
  assert.match(rule[0]!, /task report --task \S+ --state doing --estimate \d+ --title .* --description-file \S+ --expected-task-hash \S+/);
});

test('no other skill file repeats the estimate rule', () => {
  const others = files(skills).filter(file => file !== owner && readFileSync(file, 'utf8').includes('--estimate'));
  assert.deepEqual(others.map(file => relative(skills, file)), []);
});
