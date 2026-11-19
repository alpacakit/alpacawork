/** A field marked required: a done report waits for its value; a write of some fields never does. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DEFAULT_FIELDS, REQUIRED_MARK } from '@alpacawork/contract';
import { TaskReportService } from '@alpacawork/backend/test-dist/control/report.js';
import { listFields, readSchema, setField } from '@alpacawork/backend/test-dist/control/field-commands.js';
import { taskFlow } from './task-flow.fixture.ts';

test('field set marks a field required, and field get says so on the field without asking it of every write', async t => {
  const f = await taskFlow(t);
  assert.deepEqual(DEFAULT_FIELDS.filter(def => def.required).map(def => def.id), ['conclusion', 'left_running'],
    'by default a done report needs the conclusion and what was left running');
  setField(f.root, { field: 'conclusion', required: true }, new Date().toISOString());
  assert.equal(listFields(f.root).fields.find(field => field.id === 'conclusion')!.required, true);
  const schema = readSchema(f.root, null).schema as { required?: string[]; properties: Record<string, Record<string, unknown>> };
  assert.equal(schema.properties.conclusion![REQUIRED_MARK], true);
  assert.match(String(schema.properties.conclusion!.description), /^Required by the final report\./);
  assert.equal(schema.properties.goal![REQUIRED_MARK], undefined);
  assert.ok(!schema.required?.includes('conclusion'), 'a write sends only what it changes');
  setField(f.root, { field: 'conclusion', required: false }, new Date().toISOString());
  assert.equal(listFields(f.root).fields.find(field => field.id === 'conclusion')!.required, false);
});

test('a done report is refused while a required field is empty, naming each; doing and partial writes are not', async t => {
  const f = await taskFlow(t);
  for (const field of ['conclusion', 'left_running']) setField(f.root, { field, required: true }, new Date().toISOString());
  const task = await f.task('Finish'), seat = await f.work(task);
  const report = async (state: 'doing' | 'done', values?: object) => new TaskReportService(f.root).report({ task: seat.id, state,
    title: `${state} report`, description: `The work is ${state}.`, ...(values ? { values } : {}), opId: randomUUID(), expectedTaskHash: (await f.get(seat.id)).hash },
  { kind: 'placement', placementId: seat.placementId },
  { kind: 'run', runId: seat.runId, placementId: seat.placementId, taskId: seat.id, role: 'owner', responsible: true });
  // Partial writes never ask for the required fields.
  await report('doing', { notes: 'Halfway' });
  await f.commands.update({ id: seat.id, values: { conclusion: 'Found it' }, expectedTaskHash: (await f.get(seat.id)).hash });
  const before = await f.get(seat.id);
  await assert.rejects(report('done'), (error: { code: string; issues?: { path: string }[]; reason?: { kind: string } }) =>
    error.code === 'invalid_input' && error.reason?.kind === 'required_values_missing'
    && JSON.stringify(error.issues?.map(issue => issue.path)) === JSON.stringify(['left_running']));
  assert.equal((await f.get(seat.id)).hash, before.hash, 'a refused done report writes nothing');
  // The report's own values count: written with it, the done report goes through.
  await report('done', { left_running: ['none'] });
  assert.equal((await f.get(seat.id)).meta.baseState, 'done');
});
