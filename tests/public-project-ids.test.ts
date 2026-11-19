import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseTaskId, publicTaskId, initialControlDocument } from '@alpacawork/raw';
import { taskIdSchema, projectIdSchema } from '@alpacawork/contract/fields';
import { taskTokens, formatTask, taskStatement } from '@alpacawork/contract/coordinator';
import { controlDatabasePath } from '@alpacawork/db';
import { initializeWorkspace } from '@alpacawork/backend/test-dist/control/initialize.js';
import { projectLocationsSchema } from '@alpacawork/backend/test-dist/config.js';
import { isolatedServe, cliSync } from './helpers/http-cli.ts';

test('public identity has one kind-aware grammar and generation rule', () => {
  for (const kind of ['project', 'task'] as const) for (const number of [1, 273, 999999999]) {
    const id = publicTaskId(kind, number);
    assert.deepEqual(parseTaskId(id), { kind, number });
    assert.equal(taskIdSchema.parse(id), id);
  }
  for (const id of ['P0', 'T0', 'P01', 'T01', 'P1000000000', 'p273', 'P273\n', 'P273/x', 'Pabc-def']) {
    assert.equal(parseTaskId(id), null, id);
    assert.equal(taskIdSchema.safeParse(id).success, false, id);
  }
  assert.equal(projectIdSchema.safeParse('T273').success, false);
  assert.equal(projectLocationsSchema.safeParse({ T273: { cwd: '/tmp/code' } }).success, false);
  assert.equal(projectLocationsSchema.safeParse({ P273: { cwd: '/tmp/code' } }).success, true);
  for (const [id, kind] of [['T273', 'project'], ['P417', 'task']] as const)
    assert.throws(() => initialControlDocument(id, null, 'Wrong kind', { kind, userRequested: false, actor: { kind: 'human' } }), /identity mismatch/);
});

test('project labels are explicit; bare severities, old IDs, placement IDs and quoted material cannot address projects', () => {
  const known = new Map([['P1', { id: 'P1', title: 'alpacawork' }], ['P273', { id: 'P273', title: 'Project' }], ['T417', { id: 'T417', title: 'Task' }]]);
  const ids = (text: string) => taskTokens(text, id => known.get(id)).map(token => token.id);
  assert.deepEqual(ids(`${formatTask('P1', 'alpacawork')} ${formatTask('P273', 'Project')} T417`), ['P1', 'P273', 'T417']);
  assert.deepEqual(ids('ｐ１（alpacawork）'), ['P1']);
  assert.deepEqual(ids('P1（old name）'), ['P1']);
  assert.equal(taskStatement('P1（old name） act', 'P1'), 'act');
  for (const words of ['P1 finding', 'P273', 'T273', 'P417', 'P01（alpacawork）', 'P1abc-123', 'P1（unclosed',
    '「P1（alpacawork）」', '`P1（alpacawork）`', 'https://example.test/?project=P1', '[P1（alpacawork）](url)',
    '> P1（alpacawork）', '```\nP1（alpacawork）\n```']) assert.deepEqual(ids(words), [], words);
});

test('real CLI/API creates P/T on one sequence and refuses wrong-kind IDs without aliases', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'alpacawork-public-ids-')));
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'alpacawork-public-ids-home-')));
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });
  await initializeWorkspace(root);
  const server = await isolatedServe(root);
  const cli = (args: string[]) => cliSync(server.url, args, { HOME: home });
  const ok = (args: string[]) => { const result = cli(args); assert.equal(result.code, 0, result.stderr); return JSON.parse(result.stdout); };
  try {
    assert.equal(ok(['task', 'get', '--task', 'P1']).task.kind, 'project');
    assert.equal(ok(['task', 'new', '--kind', 'project', '--color', '#39659b', '--parent', 'P1', '--title', 'Nested']).task.id, 'P2');
    const task = ok(['task', 'new', '--parent', 'P2', '--title', 'Work']).task;
    assert.equal(task.id, 'T3'); assert.equal(task.parentId, 'P2');
    assert.equal(ok(['task', 'new', '--kind', 'project', '--color', '#39659b', '--parent', 'P2', '--title', 'Deeper']).task.id, 'P4');
    assert.notEqual(cli(['task', 'get', '--task', 'T1']).code, 0);
    // The CLI sends the ID as written; the one entry takes the real one and refuses each other form.
    const known = await fetch(new URL('/api/task/get?task=P1', server.url)); await known.arrayBuffer(); assert.equal(known.status, 200);
    for (const id of ['T2', 'T4', 'P3', 'P999', 'P01', 'Pabc-def'])
      assert.notEqual((await fetch(new URL(`/api/task/get?task=${id}`, server.url))).status, 200, id);
    const db = new DatabaseSync(controlDatabasePath(root), { readOnly: true });
    try {
      assert.deepEqual(db.prepare('SELECT number,external_id FROM tasks ORDER BY number').all().map(row => [row.number, row.external_id]), [[1, 'P1'], [2, 'P2'], [3, 'T3'], [4, 'P4']]);
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    } finally { db.close(); }
    const index = await (await fetch(new URL('/api/workspace/live', server.url))).json() as any;
    assert.deepEqual(index.projects.map((project: any) => project.id), ['P1', 'P2', 'P4']);
    assert.equal(index.tasks.find((row: any) => row.id === 'T3').projectId, 'P2');
  } finally { await server.stop(); }
});
