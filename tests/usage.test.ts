import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSpan, runUsage, sumRunUsage, sumUsage, type ControlRunDTO } from '@alpacawork/contract';

const iso = (minute: number) => new Date(Date.UTC(2026, 9, 5, 12, minute)).toISOString();
const run = (id: string, changes: Partial<ControlRunDTO> = {}): ControlRunDTO => ({
  id, taskId: 'T1', placementId: 'P1', agent: 'codex', launchValues: {}, modelId: null, effort: null,
  requestId: `request-${id}`, caller: null, cwd: '/synthetic',
  resumes: null, continues: false, session: null, state: 'succeeded', reason: null, into: null, takesInput: false,
  activity: null, processStarted: true, createdAt: iso(0), startedAt: iso(1), endedAt: iso(3), usage: null, ...changes,
});

test('one Run interval rule excludes queued and stranded Runs and drives additive elapsed time', () => {
  assert.deepEqual(runSpan(run('R1'), Date.parse(iso(5))),
    { from: Date.parse(iso(1)), to: Date.parse(iso(3)) });
  assert.equal(runSpan(run('R2', { state: 'needs_review', endedAt: null }), Date.parse(iso(5))), null);
  assert.equal(runSpan(run('R3', { startedAt: null }), Date.parse(iso(5))), null);
  assert.equal(runSpan(run('R4', { endedAt: iso(1) }), Date.parse(iso(5))), null);
  const known = run('R5', { usage: { run: { input: 10, cacheRead: 3, cacheWrite: 2, output: 5 }, includesEarlier: true } });
  const live = run('R6', { state: 'running', startedAt: iso(2), endedAt: null });
  const reserved = run('R7', { processStarted: false });
  assert.deepEqual(sumUsage([known, live, reserved], Date.parse(iso(5))), {
    runs: 2, runMs: 5 * 60_000, tokens: { input: 10, cacheRead: 3, cacheWrite: 2, output: 5 }, tokensUnknown: 0,
  });
  assert.equal(sumRunUsage([runUsage(live)], Date.parse(iso(5))).live, 1);
  assert.equal(sumUsage([{ ...live, state: 'succeeded', endedAt: iso(5) }], Date.parse(iso(5))).tokensUnknown, 1);
});
