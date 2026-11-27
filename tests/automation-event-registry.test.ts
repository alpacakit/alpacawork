import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

test('one event row supplies the task reader, validation, preview candidates and display', async t => {
  const contractUrl = import.meta.resolve('@alpacawork/contract/automation-program');
  const hook = registerHooks({ load(url, context, load) {
    const loaded = load(url, context);
    if (url !== contractUrl) return loaded;
    const marker = 'const eventSchemas =';
    const source = String(loaded.source);
    assert.ok(source.includes(marker));
    return { ...loaded, source: source.replace(marker, `
      automationEvents['fixture.completion'] = eventDefinition('fixture.completion', stateWhere,
        eventBase.extend({ kind: z.literal('fixture.completion'), ...words, from: state, to: state }), {
          textKey: 'trigger.state', textFormat: 'state', source: 'task_event', candidates: 'task',
          taskRecord: { event: 'state_changed', fields: ['from', 'to'] },
          matches: (where, event) => anyOf(where.to, event.to),
          example: () => ({ ...taskExample, from: 'doing', to: 'done' }),
          display: event => taskDisplay(event, [['to', event.to]]),
        });
      ` + marker) };
  } });
  t.after(() => hook.deregister());
  const { automationEventDisplay, automationEventSchema, automationWrittenEvent } = await import('@alpacawork/contract/automation-program');
  const { BundleEngine } = await import('@alpacawork/backend/test-dist/automations/bundle-engine.js');
  const { bundleEventCandidates, bundleEventChoice } = await import('@alpacawork/backend/test-dist/automations/bundle-events.js');
  const { bundleLifecycle, createBundleAutomation, prepareAutomationVersion, updateBundleReview } =
    await import('@alpacawork/backend/test-dist/automations/bundle-store.js');
  const { listBundleRuns } = await import('@alpacawork/backend/test-dist/automations/bundle-runs.js');
  const { bundleNowWrite, bundleNowRead } = await import('@alpacawork/backend/test-dist/automations/bundle-runtime.js');
  const { taskFlow } = await import('./task-flow.fixture.ts');
  const flow = await taskFlow(t);
  const human = { kind: 'human' } as const;
  const version = prepareAutomationVersion(flow.root, [{ path: 'main.ts', source: `
    export const config = { on: { event: 'fixture.completion', where: { to: 'done' } }, limits: { perDay: 5 } };
    /** Report the completion. */
    export function run() { return { summary: 'Completed' }; }
  ` }]);
  const active = bundleNowWrite(flow.root, db => {
    const now = new Date();
    const { automation } = createBundleAutomation(db, flow.project, 'Read completions', version, human, now.toISOString());
    updateBundleReview(db, automation, version.digest, { state: 'ok', findings: [], summary: '', model: null,
      at: now.toISOString(), acknowledged: null });
    return bundleLifecycle(db, flow.root, automation, { kind: 'enabled', acknowledge: false }, human, now);
  });
  assert.ok(active.eventAfter !== null);
  const seat = await flow.work(await flow.task('Finish this task'));
  await flow.report(seat, 'done');
  flow.end(seat);

  const engine = new BundleEngine(flow.root, async work => work(), () => {});
  t.after(() => engine.close());
  await engine.scan();
  bundleNowRead(flow.root, db => {
    const [run] = listBundleRuns(db, active, 5);
    assert.equal(run?.event.kind, 'fixture.completion');
    const candidates = bundleEventCandidates(db, flow.root, version.config, flow.project, active, new Date());
    assert.equal(candidates.length, 1);
    const event = candidates[0]!;
    assert.equal(event.ref, run?.event.ref);
    assert.deepEqual(automationEventDisplay(event), { title: `${seat.id} done report`, fields: [['task', seat.id], ['to', 'done']] });
    const written = automationWrittenEvent(event.kind, event.at, event);
    assert.ok(automationEventSchema.safeParse(written).success);
    assert.deepEqual(bundleEventChoice(db, flow.root, version.config, flow.project, active, { syntheticEvent: written }, new Date()), written);
  });
});
