import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { automationProgramRunsViewSchema, type ProgramAutomationEvent } from '@alpacawork/contract/automation-program';
import { bundleCommands } from '@alpacawork/backend/test-dist/automations/bundle-commands.js';
import {
  appendBundleSignal, bundleAutomationView, enqueueBundleRun, settleBundleRun,
} from '@alpacawork/backend/test-dist/automations/bundle-runs.js';
import { bundleNowWrite } from '@alpacawork/backend/test-dist/automations/bundle-runtime.js';
import {
  bundleLifecycle, createBundleAutomation, prepareAutomationVersion, updateBundleReview, type BundleAutomation,
} from '@alpacawork/backend/test-dist/automations/bundle-store.js';
import { taskFlow } from './task-flow.fixture.ts';

const human = { kind: 'human' } as const;
const when = (at: string) => new Date(at);
const now = when('2026-01-08T12:00:00Z');

async function fixture(t: TestContext) {
  const { root, project } = await taskFlow(t);
  const prepared = prepareAutomationVersion(root, [{
    path: 'main.ts', source: `
      export const config = { on: { event: 'signal' }, timezone: 'Asia/Tokyo', limits: { perDay: 5 } };
      /** Record a synthetic result. */
      export function run() { return { summary: 'Recorded' }; }
    `,
  }]);
  const write = <T>(work: (db: DatabaseSync) => T) => bundleNowWrite(root, work);
  const create = (db: DatabaseSync, name: string) =>
    createBundleAutomation(db, project, name, prepared, human, '2025-12-31T00:00:00Z').automation;
  return { root, write, create };
}

function admit(db: DatabaseSync, automation: BundleAutomation, ref: string, date: string, mode: 'live' | 'trial' = 'live') {
  const at = when(date).toISOString();
  const event: ProgramAutomationEvent = { kind: 'signal', ref, at, manual: true, count: 1, firstAt: at, lastAt: at, items: [] };
  return enqueueBundleRun(db, automation, automation.latest, event, mode, when(date));
}

test('weekly counts use local days and count runs independently of trials and folded signals', async t => {
  const { root, write, create } = await fixture(t);
  const week = await write(db => {
    const draft = create(db, 'Weekly signal totals');
    updateBundleReview(db, draft, draft.latest, { state: 'ok', findings: [], summary: '', model: null,
      at: '2025-12-31T00:00:00.000Z', acknowledged: null });
    const a = bundleLifecycle(db, root, draft, { kind: 'enabled', acknowledge: true }, human, when('2025-12-31T00:00:00Z'));
    const start = (number: number, date: string) =>
      db.prepare('UPDATE automation_runs SET run_started_at=? WHERE automation_id=? AND number=?')
        .run(when(date).toISOString(), a.uuid, number);
    // This older match is outside the cohort, but its start still counts against the daily limit.
    const older = admit(db, a, 'older', '2026-01-01T14:59:00Z');
    start(older.number, '2026-01-01T15:00:00Z');
    settleBundleRun(db, a, older.number, when('2026-01-01T15:01:00Z'), { state: 'done' });

    const failed = admit(db, a, 'failed', '2026-01-01T15:02:00Z');
    start(failed.number, '2026-01-01T17:02:00Z');
    settleBundleRun(db, a, failed.number, when('2026-01-01T17:03:00Z'), { state: 'failed', reason: 'Synthetic failure' });

    const rejected = appendBundleSignal(db, a, 'signal', 'folded-deliveries', {
      at: '2026-01-08T01:00:00.000Z', by: human, key: 'first', data: null,
    }, when('2026-01-08T01:00:00Z'));
    appendBundleSignal(db, a, 'signal', 'coalesced-delivery', {
      at: '2026-01-08T01:01:00.000Z', by: human, key: 'second', data: null,
    }, when('2026-01-08T01:01:00Z'));
    const skip = { state: 'skipped', kind: 'daily_limit', reason: 'Daily limit' } as const;
    settleBundleRun(db, a, rejected.number, when('2026-01-08T01:01:00Z'), skip);
    const next = admit(db, a, 'another-skip', '2026-01-08T02:00:00Z');
    settleBundleRun(db, a, next.number, when('2026-01-08T02:00:01Z'), skip);
    const oldSkip = admit(db, a, 'previous-week-skip', '2026-01-01T14:59:00Z');
    settleBundleRun(db, a, oldSkip.number, when('2026-01-08T02:05:00Z'), skip);

    const later = admit(db, a, 'later', '2026-01-08T03:00:00Z');
    start(later.number, '2026-01-08T03:00:01Z');
    const trial = admit(db, a, 'trial', '2026-01-08T05:00:00Z', 'trial');
    start(trial.number, '2026-01-08T05:00:01Z');
    settleBundleRun(db, a, trial.number, when('2026-01-08T05:00:02Z'), { state: 'failed' });
    return bundleAutomationView(db, root, a, now).week;
  });
  assert.deepEqual(week, { matched: 4, started: 2, skipped: 2, failed: 1, busiestDay: 2,
    skippedBy: [{ reason: 'daily_limit', count: 2 }] });
});

test('the all-automation runs command pages by time with stable ties', async t => {
  const { root, write, create } = await fixture(t);
  const [first, second] = await write(db => {
    const first = create(db, 'First automation'), second = create(db, 'Second automation');
    admit(db, second, 'earliest', '2026-01-08T01:00:00Z');
    admit(db, first, 'first tie', '2026-01-08T02:00:00Z');
    admit(db, second, 'other tie', '2026-01-08T02:00:00Z');
    admit(db, second, 'second tie', '2026-01-08T02:00:00Z');
    admit(db, first, 'newest', '2026-01-08T03:00:00Z');
    return [first, second];
  });
  const page = (cursor?: string, automation?: string) => automationProgramRunsViewSchema.parse(
    bundleCommands['automation/runs'].run(root, { limit: 2, cursor, automation }, { actor: human, caller: () => human }));
  const firstPage = page();
  assert.ok(firstPage.nextCursor);
  await write(db => admit(db, first, 'new arrival', '2026-01-08T04:00:00Z'));
  const secondPage = page(firstPage.nextCursor);
  assert.ok(secondPage.nextCursor);
  const thirdPage = page(secondPage.nextCursor);
  assert.equal(thirdPage.nextCursor, null);
  assert.deepEqual([...firstPage.runs, ...secondPage.runs, ...thirdPage.runs].map(run => [run.automationId, run.number]),
    [[first.id, 2], [second.id, 3], [second.id, 2], [first.id, 1], [second.id, 1]]);
  const ownPage = page(undefined, first.id);
  assert.deepEqual(ownPage.runs.map(run => [run.automationId, run.number]), [[first.id, 3], [first.id, 2]]);
  assert.ok(ownPage.nextCursor);
  assert.deepEqual(page(ownPage.nextCursor, first.id).runs.map(run => run.number), [1]);
});
