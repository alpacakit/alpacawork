/** What a Run ran under, kept once just before its agent starts, and what changed between two Runs. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { conditionChanges, launchChanges, observeConditions, readConditions, recordConditions } from '@alpacawork/backend/test-dist/runs/conditions.js';

test('a Run keeps the skills it could read and alpacawork\'s version once; an updated skill and a switched model read as changes', t => {
  const home = mkdtempSync(join(tmpdir(), 'run-conditions-')), run = join(home, 'run');
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(run);
  const skill = (name: string, text: string) => { mkdirSync(join(home, '.agents/skills', name), { recursive: true }); writeFileSync(join(home, '.agents/skills', name, 'SKILL.md'), text); };
  skill('alpacawork', 'v1'); skill('askmeclearly', 'v1');
  const observe = () => observeConditions({ adapter: 'codex', cwd: home, version: '0.1.7', release: null, home });
  const first = observe();
  recordConditions(run, () => first);
  skill('alpacawork', 'v2'); skill('dontspaghettimycode', 'v1');
  // A manager started again for the same Run keeps what the first saw.
  recordConditions(run, observe);
  assert.deepEqual(readConditions(run), first);
  assert.deepEqual(first.skills[0]!.items.map(item => item.name), ['alpacawork', 'askmeclearly']);
  assert.equal(first.cwd.commit, null);
  assert.deepEqual(conditionChanges(first, { ...observe(), version: '0.1.8' }).map(({ kind, name }) => [kind, name?.split('/').at(-1) ?? null]),
    [['release', null], ['skill', 'alpacawork'], ['skill', 'dontspaghettimycode']]);
  const launch = (model: string) => ({ launch: { adapter: 'claude', argv: ['claude'], path: '/bin/claude', values: { model, effort: 'medium' }, env: [] } });
  assert.deepEqual(launchChanges(launch('opus'), launch('fable')), [{ kind: 'model', name: null, before: 'opus', after: 'fable' }]);
});
