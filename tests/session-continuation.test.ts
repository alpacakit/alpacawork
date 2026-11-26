import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { taskInputSession } from '../apps/backend/src/runs/session-continuation.ts';
import type { RuntimeRunRecord } from '../packages/contract/src/run-contract.ts';

test('a Task instruction admitted before session discovery joins only its compatible working ancestor', () => {
  const session = { provider: 'fake', id: 'discovered' };
  const base = { role: 'owner', agent: 'fake', launch: { adapter: 'fake', values: { model: 'm', effort: 'high' } }, session: null };
  const working = { ...base, id: 'R8', state: 'running', resumes: null, session } as unknown as RuntimeRunRecord;
  const first = { ...base, id: 'R9', state: 'queued', resumes: 'R8' } as unknown as RuntimeRunRecord;
  const second = { ...base, id: 'R10', state: 'queued', resumes: 'R9' } as unknown as RuntimeRunRecord;
  const runs = [working, first, second];
  const inputSession = (chain: readonly RuntimeRunRecord[], next: RuntimeRunRecord, live: RuntimeRunRecord) =>
    taskInputSession(chain, next, live);
  assert.deepEqual(inputSession(runs, second, working), session);
  assert.equal(inputSession(runs, { ...second, launch: { ...second.launch, values: { ...second.launch.values, model: 'other' } } }, working), null);
  assert.equal(inputSession(runs, { ...second, session: { ...session, id: 'other' } }, working), null);
  assert.equal(inputSession(runs, { ...second, agent: 'other' } as RuntimeRunRecord, working), null);
  assert.equal(inputSession(runs, { ...second, launch: { ...second.launch, adapter: 'claude' } }, working), null);
  assert.equal(inputSession(runs, { ...second, resumes: null }, working), null);
  assert.equal(inputSession([working, { ...first, state: 'running' }, second], second, working), null);
  assert.equal(inputSession(runs, second, { ...working, state: 'succeeded' }), null);
  assert.equal(inputSession([working, { ...first, session: { ...session, id: 'other' } }, second], second, working), null);
});
