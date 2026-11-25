/** What a Run ran under, kept once just before its agent starts. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { observeConditions, readConditions, recordConditions } from '@alpacawork/backend/test-dist/runs/conditions.js';

test('a Run keeps once what it could read: each skill folder apart, the person\'s instruction files, and a digest that moves with each', t => {
  const home = mkdtempSync(join(tmpdir(), 'run-conditions-')), work = join(home, 'work'), run = join(home, 'run');
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(run);
  const skill = (folder: string, text: string) => { mkdirSync(join(folder, 'example'), { recursive: true }); writeFileSync(join(folder, 'example', 'SKILL.md'), text); };
  skill(join(home, '.agents/skills'), 'v1'); skill(join(work, '.claude/skills'), 'v1'); skill(join(work, '.agents/skills'), 'v1');
  mkdirSync(join(home, '.agents'), { recursive: true }); writeFileSync(join(home, '.agents/AGENTS.md'), 'rules v1');
  const observe = () => observeConditions({ adapter: 'codex', cwd: work, version: '0.1.7', release: null, home });
  const first = observe();
  recordConditions(run, () => first);
  skill(join(work, '.claude/skills'), 'v2'); writeFileSync(join(home, '.agents/AGENTS.md'), 'rules v2');
  // A manager started again for the same Run keeps what the first saw.
  recordConditions(run, observe);
  assert.deepEqual(readConditions(run), first);
  const later = observe(), digests = (c: typeof first) => c.skills.map(({ scope, folder, items }) => [scope, folder.slice(home.length), items[0]!.digest]);
  assert.deepEqual(first.skills.map(({ scope, folder }) => [scope, folder.slice(home.length)]),
    [['personal', '/.agents/skills'], ['project', '/work/.claude/skills'], ['project', '/work/.agents/skills']]);
  // Only the updated folder's skill and the updated instruction file read differently.
  assert.deepEqual(digests(first).map((each, at) => each[2] === digests(later)[at]![2]), [true, false, true]);
  assert.deepEqual(first.instructions.map(item => item.path.slice(home.length)), ['/.agents/AGENTS.md']);
  assert.notEqual(first.instructions[0]!.digest, later.instructions[0]!.digest);
  assert.equal(first.cwd.commit, null);
});
