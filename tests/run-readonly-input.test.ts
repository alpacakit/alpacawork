/** Immutable read inputs and mutable DTO/write boundaries must not share nested state. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runRecordSchema, type ReadRunRecord, type RunRecord } from '@alpacawork/contract/run';
import { controlRunSchema } from '@alpacawork/contract/control';
import { RunStore } from '@alpacawork/runs';
import { ControlTaskCommands } from '@alpacawork/backend/test-dist/control/task-commands.js';
import { controlRuns } from '@alpacawork/backend/test-dist/control/tree.js';
import { initializeControlFixture } from './helpers/control-fixture.ts';
import { createFixtureRun } from './helpers/run-fixture.ts';
import { fields, record } from './runs-fixtures.ts';

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function frozenRecord(changes: Partial<RunRecord> = {}): ReadRunRecord {
  return freeze(runRecordSchema.parse(record('R1', {
    caller: { run: 'R2' }, session: { provider: 'codex', id: 'session-one' },
    usage: { run: { input: 1, cacheRead: 2, cacheWrite: 3, output: 4 }, conversation: null, includesEarlier: false },
    ...changes,
  })));
}

for (const field of ['caller', 'session', 'usage'] as const) {
  test(`the mutable control Run DTO owns its ${field} independently of a frozen input`, t => {
    const root = mkdtempSync(join(tmpdir(), 'alpacawork-read-run-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const input = frozenRecord(), before = structuredClone(input);
    const dto = controlRuns(root, [input])[0]!;
    assert.deepEqual(controlRunSchema.parse(dto), dto, 'the converter already returns its public schema shape');
    assert.deepEqual(dto.caller, input.caller);
    assert.deepEqual(dto.session, input.session);
    assert.deepEqual(dto.usage, { run: input.usage!.run, includesEarlier: input.usage!.includesEarlier });
    const expected = structuredClone(dto);
    if (field === 'caller') {
      assert.notEqual(dto.caller, input.caller);
      dto.caller!.run = 'R99';
    } else if (field === 'session') {
      assert.notEqual(dto.session, input.session);
      dto.session!.id = 'changed-session';
    } else {
      assert.notEqual(dto.usage!.run, input.usage!.run);
      dto.usage!.run!.input = 99;
    }
    assert.deepEqual(input, before, 'DTO edits do not change the reader-owned record');
    assert.deepEqual(controlRuns(root, [input])[0], expected, 'another projection retains original values');
  });
}

test('the readonly converter preserves absent metadata and unknown token counters', t => {
  const root = mkdtempSync(join(tmpdir(), 'alpacawork-read-run-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const absent = controlRuns(root, [frozenRecord({ caller: null, session: null, usage: null })])[0]!;
  assert.equal(absent.caller, null);
  assert.equal(absent.session, null);
  assert.equal(absent.usage, null);
  const unknown = controlRuns(root, [frozenRecord({ usage: { run: null, conversation: null, includesEarlier: true } })])[0]!;
  assert.deepEqual(unknown.usage, { run: null, includesEarlier: true });
});

test('mutable Run snapshots remain detached and writable', async t => {
  const root = mkdtempSync(join(tmpdir(), 'alpacawork-mutable-run-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = initializeControlFixture(root);
  const task = (await new ControlTaskCommands(root, { kind: 'human' }).create({ parentId: project, userRequested: false,
    tasks: [{ title: 'Mutable snapshot' }] })).tasks[0]!;
  const store = new RunStore(root, { busyTimeoutMs: 1000 });
  try {
    const created = store.write(tx => createFixtureRun(store, tx, fields({ task: task.id }), 'mutable snapshot'));
    const snapshot = store.snapshot();
    const read = snapshot.records!.find(run => run.id === created.id)!;
    read.launch.argv.push('caller-local');
    read.pids.agent = 42;
    snapshot.records!.push(record('R99'));
    assert.deepEqual(store.snapshot().records, [created], 'edits to a snapshot are not stored or shared');
  } finally { store.close(); }
});

