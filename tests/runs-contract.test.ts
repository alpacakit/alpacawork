/** Validate the browser-safe run boundary, including strict nested objects. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RUN_ENDED_STATES, compareRunIds, coordinatorRunRecordSchema, runFolder, runRecordSchema, runtimeRunRecordSchema, RUN_STATE,
  RUN_STATE_REASONS } from '@alpacawork/contract/run';
import { record, time } from './runs-fixtures.ts';

/** A coordinator Run answering a message in the screen's conversation: no Task, placement or caller. */
const coordinator = (fields: Record<string, unknown> = {}) => ({ ...record('R2'), task: null, placementId: null, role: 'coordinator',
  caller: null, conversationId: '0b6f7e52-5a1d-4c7e-9b8a-3f2d1c0e9a77', message: { context: 'T3', attachments: ['a.png'],
    intent: { task: 'T3', action: 'approve', aboutRun: 'R1' } }, ...fields });

test('complete run record and every state/reason pair', () => {
  assert.deepEqual(runRecordSchema.parse(record()), record());
  assert.equal(Object.keys(RUN_STATE).length, 7);
  for (const [state, reasons] of Object.entries(RUN_STATE_REASONS)) for (const reason of reasons)
    assert.ok(runRecordSchema.safeParse({ ...record(), state, reason, ended_at: time,
      into: state === 'joined' ? 'R2' : null }).success, `${state}/${reason}`);
  assert.ok(runRecordSchema.safeParse(record('R1', { session: { provider: null, id: 'local' } })).success);
  assert.ok(runRecordSchema.safeParse(record('R1', { task: 'T19', resumes: 'R2' })).success);
});
for (const extra of [
  { surprise: true }, { id: 'R0' }, { id: 'R01' }, { id: 'R2\n' }, { task: 'T1junk' }, { task: 'T1\n' },
  { agent: 'Codex' }, { agent: 'codex\n' }, { role: 'manager' }, { resumes: 'R0' }, { continues: true }, { continues: true, resumes: 'R2' }, { requestId: null }, { caller: { session: { provider: 'codex', id: 'old' } } },
  { cwd: 'relative' }, { state: 'starting' }, { state: 'queued', reason: 'exit' },
  { state: 'failed', reason: null, ended_at: time }, { state: 'succeeded', ended_at: null }, { started_at: time },
  { session: { provider: 'Other', id: 'x' } }, { session: { provider: 'codex', id: '' } },
  { session: { provider: null, id: 'x', extra: 1 } }, { caller: { run: 'R1', session: { provider: 'codex', id: 'x' } } },
  { caller: { session: { provider: null, id: 'x' } } }, { caller: { session: { provider: 'codex', id: 'x', extra: 1 } } },
  { launch: { adapter: 'codex', env: [], argv: [], path: '/bin', values: {}} }, { launch: { adapter: 'codex', env: [], argv: ['x'], path: '', extra: true } },
  { exit: { code: 0, signal: null, extra: 1 } }, { pids: { manager: 1.5, agent: null } },
  { pids: { manager: null, agent: null, extra: 1 } }, { created_at: 'yesterday' },
  { state: 'joined', ended_at: time }, { into: 'R2' }, { state: 'succeeded', ended_at: time, into: 'R2' },
]) test(`rejects invalid record ${JSON.stringify(extra)}`, () => {
  assert.equal(runRecordSchema.safeParse({ ...record(), ...extra }).success, false);
});

test('a Task Run record is never a coordinator\'s, which only the execution layer reads beside it', () => {
  assert.equal(runRecordSchema.safeParse({ ...record(), role: 'coordinator' }).success, false);
  assert.equal(runRecordSchema.safeParse({ ...record(), conversationId: coordinator().conversationId }).success, false);
  assert.equal(runRecordSchema.safeParse(coordinator()).success, false);
  assert.deepEqual(runtimeRunRecordSchema.parse(record()), record());
  assert.deepEqual(runtimeRunRecordSchema.parse(coordinator()), coordinator());
  assert.deepEqual(runtimeRunRecordSchema.parse(coordinator({ joinRequested: true })), coordinator({ joinRequested: true }));
});
for (const extra of [
  { task: 'T3' }, { placementId: 'Ptest' }, { caller: { run: 'R1' } }, { role: 'owner' }, { conversationId: 'conversation' },
  { conversationId: null }, { message: null }, { message: { context: null, attachments: [] } }, { joinRequested: false },
]) test(`rejects invalid coordinator record ${JSON.stringify(extra)}`, () => {
  assert.equal(coordinatorRunRecordSchema.safeParse(coordinator(extra)).success, false);
  assert.equal(runtimeRunRecordSchema.safeParse(coordinator(extra)).success, false);
});

test('contract adds no lifecycle invariants beyond those declared', () => {
  assert.ok(runRecordSchema.safeParse(record('R1', { state: 'running', ended_at: time, pids: { manager: -1, agent: 0 },
    exit: { code: null, signal: null }, launch: { adapter: 'codex', env: [], argv: ['x', ''], path: '/bin', values: {}} })).success);
});


test('Fix 3: succeeded with denied is rejected', () => {
  assert.equal(runRecordSchema.safeParse({ ...record(), state: 'succeeded', reason: 'denied', ended_at: time }).success, false);
});

test('run numbers order runs and name their folders', () => {
  const ordered = ['R10', 'R2', 'R1'].map(id => ({ id })).sort(compareRunIds).map(run => run.id);
  assert.deepEqual(ordered, ['R1', 'R2', 'R10']);
  assert.equal(runFolder('/work/', 'R3'), '/work/.alpacawork/runs/R3');
  assert.equal(runFolder('/', 'R3'), '/.alpacawork/runs/R3');
  assert.deepEqual([...RUN_ENDED_STATES], ['succeeded', 'failed', 'cancelled', 'joined']);
});
