/** A frozen pre-extraction decision corpus, independent of the candidate's permission table. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Problem } from '@alpacawork/core';
import { decide, type Action, type Caller, type TaskFacts } from '@alpacawork/backend/test-dist/control/authorize.js';

const states = ['todo', 'doing', 'waiting', 'done', 'stopped', 'error', 'held'] as const;
const bases = ['todo', 'doing', 'waiting', 'done', 'stopped', 'error'] as const;
const run = (taskId: string, role: 'owner' | 'worker' = 'owner', responsible = role === 'owner'): Caller =>
  ({ kind: 'run', runId: 'R1', placementId: `P${taskId}`, taskId, role, responsible });
const callers: readonly Caller[] = [run('T3'), run('T2'), run('T3', 'worker'), run('T4'), run('T5'), run('T20'),
  run('T3', 'owner', false), { kind: 'human' },
  { kind: 'coordinator', conversation: 'C1', source: 'codex' },
  { kind: 'coordinator', conversation: 'C2', source: 'screen', provider: 'claude', runId: 'R2' }];
const actions: readonly Action[] = [
  { name: 'task.read' }, { name: 'task.list' },
  ...(['task', 'project'] as const).flatMap(kind => [null, false, true].map(userRequested =>
    ({ name: 'task.new' as const, kind, userRequested }))),
  ...(['title', 'body', 'cwd', 'extracts', 'userRequested'] as const).map(field =>
    ({ name: 'task.update' as const, fields: [field] as [typeof field] })),
  { name: 'task.update', fields: ['title', 'body', 'cwd', 'extracts', 'userRequested'] },
  { name: 'task.move', to: ['T5', 'T2', 'T1'] }, { name: 'task.move', to: ['T1'] },
  ...(['task.archive', 'task.delete', 'task.restore'] as const).map(name => ({ name })),
  ...states.flatMap(state => [false, true].flatMap(checkpoint => [false, true].map(confirmation =>
    ({ name: 'task.report' as const, state, checkpoint, confirmation })))),
  { name: 'task.withdraw' }, { name: 'task.comment', urgent: false }, { name: 'task.comment', urgent: true },
  { name: 'task.request', worker: false }, { name: 'task.request', worker: true },
  ...[null, 'T2', 'T5'].flatMap(askedTo => [false, true].map(closed =>
    ({ name: 'task.answer' as const, askedTo, closed }))),
  ...(['agent.assign', 'agent.release'] as const).flatMap(name => [false, true].map(worker => ({ name, worker }))),
  ...(['agent.handover', 'run.stop', 'file.write', 'screen', 'coordinator.screen', 'runtime', 'config.set', 'admin', 'release'] as const)
    .map(name => ({ name })),
];

/** The body and extracts updates no longer exist (values replace them); the frozen corpus still keeps their rows. */
const retired = (action: Action) => action.name === 'task.update' && action.fields.some(field => ['body', 'extracts'].includes(field as string));
/**
 * A Run may now read the projects above its own: a refusal now also names that grant. Who is allowed or refused, and
 * every other refusal field, stay compared with the frozen corpus; only that added grant is left out of the reason.
 */
function withoutProjectAbove(reason: unknown) {
  const grants = (reason as { grants?: unknown })?.grants;
  return Array.isArray(grants) ? { ...(reason as object), grants: grants.filter(grant => !(grant as string[]).includes('project_above')) } : reason;
}
function corpus() {
  const tasks: (TaskFacts | null)[] = [null];
  // Cross state/base/hold deliberately: decide's facts boundary must remain invariant even for stale snapshots.
  for (const kind of ['task', 'project'] as const) for (const state of states) for (const baseState of bases)
    for (const hold of [false, true]) for (const userRequested of [false, true]) tasks.push({ id: 'T3', kind,
      parentId: kind === 'project' ? null : 'T2', project: 'T1', state, baseState, hold, userRequested });
  return actions.filter(action => !retired(action)).map(action => {
    const digest = createHash('sha256');
    let cases = 0;
    for (const task of tasks) for (const caller of callers) {
      const contexts = caller.kind === 'run'
        ? [
          { runProject: caller.taskId === 'T20' ? 'T10' : 'T1', runState: 'doing' as const },
          { runProject: 'T1', runState: 'held' as const },
          { runProject: null, runState: null },
        ] : [{ runProject: null, runState: null }];
      for (const context of contexts) for (const quote of [null, 'Proceed with this'] as const) {
        const result = decide(caller, action, { task, ...context, quote, message: 'Recorded message' });
        // Diagnostic prose may improve. Keep every semantic refusal field, actor and read scope frozen.
        const semantic = result instanceof Problem
          ? { code: result.code, detail: result.detail, reason: withoutProjectAbove(result.reason), issues: result.issues?.map(({ path, code }) => ({ path, code })) }
          : result;
        digest.update(JSON.stringify(semantic) + '\n');
        cases++;
      }
    }
    return { action, cases, sha256: digest.digest('hex') };
  });
}

test('authorization preserves the frozen 241870fb2 corpus except intentional child-creation, comment, configuration and held-management changes', () => {
  const baseline = JSON.parse(readFileSync(new URL('./fixtures/authorize-241870fb2.json', import.meta.url), 'utf8'));
  const actual = corpus();
  assert.equal(baseline.sourceCommit, '241870fb21d97379a9edbe32073d469a60b4f3e6');
  // Coordinators may now config.set, ordinary comments follow read scope, and management reports may restore a hold;
  // other inputs retain their old meaning. Full role/base/hold coverage lives in authorize.test.ts and held-restore.test.ts (real CLI + HTTP).
  const preserved = ({ action }: { action: Action }) => {
    // Child creation is now limited to its parent’s responsible Run; the full caller matrix tests the new grant.
    if (action.name === 'task.new' && action.kind === 'task' && action.userRequested !== true) return false;
    if (action.name === 'config.set') return false;
    if (action.name === 'task.comment' && !action.urgent) return false;
    if (action.name !== 'task.report') return true;
    const checkpoint = action.checkpoint && ['doing', 'waiting', 'done'].includes(action.state);
    // The corpus also includes todo/error + confirmation, which CLI validation rejects;
    // their fallback is still restore, so the same grant change affects their refusal detail.
    return !!checkpoint || action.state === 'held' || !!action.confirmation && !['todo', 'error'].includes(action.state);
  };
  assert.equal(actual.filter(row => !preserved(row)).length, 17);
  assert.deepEqual(actual.filter(preserved), baseline.decisions.filter(preserved).filter((row: { action: Action }) => !retired(row.action)));
  assert.ok(actual.reduce((sum, row) => sum + row.cases, 0) > 100_000);
});
