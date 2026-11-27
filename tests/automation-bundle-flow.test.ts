import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { stringify } from 'yaml';
import {
  automationProgramPreviewResultSchema, automationProgramRunReceiptSchema, automationProgramRunsViewSchema,
  automationProgramViewSchema, type AutomationBundle, type AutomationConfig, type AutomationProgramView,
} from '@alpacawork/contract/automation-program';
import { readBundleAutomation } from '@alpacawork/backend/test-dist/automations/bundle-store.js';
import { bundleNowRead } from '@alpacawork/backend/test-dist/automations/bundle-runtime.js';
import { taskEventTail } from '@alpacawork/backend/test-dist/control/task-history.js';
import { startServer, type ServerOptions } from '@alpacawork/backend/test-dist/receiver/server.js';
import { fixtureAgentSetting, installAgentStub } from './helpers/agent-stub.ts';
import { commandFetch } from './helpers/command-fetch.ts';
import { taskFlow } from './task-flow.fixture.ts';

const schedule: AutomationConfig = {
  on: { event: 'schedule', where: { cron: '0 0 1 1 *' } }, timezone: 'UTC', limits: { perDay: 5 },
};
const completed: AutomationConfig = {
  on: { event: 'task.state_changed', where: { to: 'done' } }, timezone: 'UTC', limits: { perDay: 5 },
};
const bundle = (config: AutomationConfig, source: string): AutomationBundle => [{
  path: 'main.ts', source: `export const config = ${JSON.stringify(config)};\n${source}`,
}];
const summaryBundle = (config: AutomationConfig, summary: string) => bundle(config, `
  /** Report one result. */
  export async function run() { return { summary: ${JSON.stringify(summary)} }; }
`);

async function eventually<T>(read: () => T | Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = performance.now() + 8_000;
  for (;;) {
    const value = await read();
    if (ready(value)) return value;
    if (performance.now() >= deadline) assert.fail(`Expected the automation to progress. Last value: ${JSON.stringify(value)}`);
    await delay(25);
  }
}

async function fixture(t: TestContext, ai = false) {
  const environment = new Map(['PATH', 'CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'ALPACAWORK_MANAGED_RELEASES']
    .map(name => [name, process.env[name]]));
  const cleanups: (() => void)[] = [];
  let cache: string | undefined;
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  t.after(async () => {
    try { await server?.close(); }
    finally {
      try {
        // Materialized bundle directories are intentionally read-only while serving.
        if (cache && existsSync(cache)) {
          for (const entry of readdirSync(cache, { recursive: true, withFileTypes: true })) {
            if (entry.isDirectory()) chmodSync(join(entry.parentPath, entry.name), 0o700);
          }
        }
        for (const clean of cleanups.reverse()) clean();
      } finally {
        for (const [name, value] of environment) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
      }
    }
  });
  const flow = await taskFlow({ after: clean => cleanups.push(clean) });
  cache = join(flow.root, '.automations');
  process.env.XDG_CONFIG_HOME = join(flow.root, 'config');
  process.env.XDG_STATE_HOME = join(flow.root, 'state');
  process.env.CLAUDE_CONFIG_DIR = join(flow.root, 'claude-settings');
  delete process.env.ALPACAWORK_MANAGED_RELEASES;
  const prompts: string[] = [];
  if (ai) {
    const fake = fixtureAgentSetting('claude');
    fake.params = Object.fromEntries(Object.keys(fake.params).map(key => [key, []]));
    writeFileSync(join(flow.root, 'config.yaml'), stringify({ agents: { fake, review: fixtureAgentSetting('claude') } }));
    const versionStub = join(flow.root, 'claude-version.mjs');
    writeFileSync(versionStub, `if (process.argv[2] === '--version') console.log('2.1.330 (Claude Code)'); else process.exit(1);\n`);
    process.env.PATH = installAgentStub(flow.root, 'claude', [process.execPath, versionStub]);
  }
  const answer: NonNullable<ServerOptions['automationJudge']> = async (_executable, input) => {
    const material = JSON.parse(input);
    if (typeof material.prompt === 'string') prompts.push(material.prompt);
    return { kind: 'answer', model: 'claude-sonnet-fixture',
      text: Array.isArray(material.files) ? '{"state":"ok","findings":[],"summary":"Reviewed"}' : 'Yes',
      usage: { costUsd: typeof material.prompt === 'string' ? 0.02 : null, inputTokens: null, outputTokens: null } };
  };
  async function start() {
    server = await startServer(flow.root, 0, { hostSource: { supported: false, platform: 'test' }, automationJudge: answer });
  }
  await start();
  async function request(command: string, input?: object, query: Record<string, string> = {}): Promise<unknown> {
    const url = new URL('/api/commands/automation/' + command, server!.url);
    url.search = new URLSearchParams(query).toString();
    const response = await commandFetch(url, input && {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
    });
    const body = await response.text();
    assert.equal(response.status, 200, body);
    return JSON.parse(body);
  }
  async function edit(command: string, input: object) {
    const result = await request(command, input);
    assert.ok(result && typeof result === 'object' && 'automation' in result);
    return automationProgramViewSchema.parse(result.automation);
  }
  const create = (name: string, files: AutomationBundle) => edit('new', { name, under: flow.project, files });
  const enable = (draft: AutomationProgramView) =>
    edit('enable', { automation: draft.id, expectedHash: draft.hash, acknowledgeReview: true });
  const save = (draft: AutomationProgramView, files: AutomationBundle) =>
    edit('save', { automation: draft.id, expectedHash: draft.hash, files });
  const runs = async (automation: string) => automationProgramRunsViewSchema.parse(await request('runs', undefined, { automation })).runs;
  const runNow = async (automation: string) => automationProgramRunReceiptSchema.parse(await request('run-now', { automation })).run;
  async function complete(title: string) {
    const seat = await flow.work(await flow.task(title));
    await flow.report(seat, 'done');
    flow.end(seat);
    return seat.id;
  }
  async function waitForEvents(automation: string) {
    // Wait for the event consumer to commit before asserting that nothing launched.
    const tail = bundleNowRead(flow.root, taskEventTail);
    await eventually(() => bundleNowRead(flow.root, db => readBundleAutomation(db, automation).eventAfter),
      current => current !== null && current >= tail);
  }
  async function restart() {
    await server!.close();
    await start();
  }
  return { ...flow, request, create, enable, edit, save, runs, runNow, complete, waitForEvents, restart, prompts };
}

test('static misses and daily-limit skips start neither the program nor AI', { timeout: 20_000 }, async t => {
  const f = await fixture(t, true);
  const marker = join(f.root, 'program-loads');
  const release = join(f.root, 'allow-trigger');
  const config: AutomationConfig = {
    ...completed, limits: { perDay: 1 }, uses: { ai: { checker: { agent: 'review', model: 'sonnet', effort: 'high' } } },
  };
  const draft = await f.create('One completion per day', bundle(config, `
    import { appendFileSync } from 'node:fs';
    import { access } from 'node:fs/promises';
    import { setTimeout as delay } from 'node:timers/promises';
    appendFileSync(${JSON.stringify(marker)}, 'loaded\\n');
    /** Ask about the task. */
    export async function trigger({ alp }) {
      for (let attempt = 0; attempt < 400; attempt++) {
        if (await access(${JSON.stringify(release)}).then(() => true, () => false)) break;
        await delay(25);
      }
      const reply = await alp.ai.ask({ ai: 'checker', prompt: 'Did the fixture finish?' });
      return { run: reply === 'Yes', reason: 'Checked the task' };
    }
    /** Report the selected task. */
    export async function run() { return { summary: 'Ran once' }; }
  `));
  const active = await f.enable(draft);
  const miss = await f.work(await f.task('Task not yet done'));
  await f.waitForEvents(active.id);
  assert.deepEqual(await f.runs(active.id), []);
  assert.equal(existsSync(marker), false);
  assert.deepEqual(f.prompts, []);

  await f.report(miss, 'done');
  f.end(miss);
  await eventually(() => existsSync(marker), Boolean);
  await f.complete('Another task finished while the first trigger was running');
  await f.waitForEvents(active.id);
  writeFileSync(release, '');
  const rows = await eventually(() => f.runs(active.id), entries => entries[0]?.state === 'skipped');
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.reasonKind, 'daily_limit');
  assert.equal(rows[0]?.startedAt, null);
  assert.equal(rows[1]?.summary, 'Ran once');
  assert.equal(readFileSync(marker, 'utf8'), 'loaded\n');
  assert.deepEqual(f.prompts, ['Did the fixture finish?']);
  const updated = await f.request('get', undefined, { automation: active.id }) as { automation: AutomationProgramView };
  assert.deepEqual(updated.automation.latest.facts.ai[0]?.costHint, { perCallUsd: 0.02 });
});

test('a state-change event is dispatched once across save, off and on, and restart', { timeout: 25_000 }, async t => {
  const f = await fixture(t);
  const initial = await f.enable(await f.create('Follow up completion', summaryBundle(completed, 'First version')));
  await f.complete('Completed during first activation');
  const beforeSave = await eventually(() => f.runs(initial.id), entries => entries[0]?.state === 'done');
  assert.equal(beforeSave.length, 1);

  const draft = await f.save(initial, summaryBundle(completed, 'Second version'));
  await f.complete('Completed immediately after saving');
  const afterSave = await eventually(() => f.runs(initial.id), entries =>
    entries.length > 1 && entries[0]?.state === 'done');
  assert.equal(afterSave.length, 2);
  assert.deepEqual(afterSave.map(run => run.summary), ['First version', 'First version']);
  assert.equal(afterSave[1]?.event.ref, beforeSave[0]?.event.ref);
  const disabled = await f.edit('disable', { automation: draft.id });
  await f.complete('Completed while automation was off');
  const active = await f.enable(disabled);
  await f.complete('Completed during second activation');
  const beforeRestart = await eventually(() => f.runs(active.id), entries => entries[0]?.summary === 'Second version');
  assert.equal(beforeRestart.length, 3);
  assert.deepEqual(beforeRestart.map(run => run.summary), ['Second version', 'First version', 'First version']);
  assert.equal(new Set(beforeRestart.map(run => run.event.ref)).size, 3);

  await f.restart();
  await f.plan('A task that does not match after restart');
  await f.waitForEvents(initial.id);
  assert.deepEqual((await f.runs(initial.id)).map(run => run.event.ref), beforeRestart.map(run => run.event.ref));
});

test('saving changes the draft and an in-flight run finishes on its original version', { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  const started = join(f.root, 'program-started');
  const release = join(f.root, 'allow-finish');
  const initial = await f.enable(await f.create('Versioned report', bundle(schedule, `
    import { writeFile, access } from 'node:fs/promises';
    import { setTimeout as delay } from 'node:timers/promises';
    /** Wait for the fixture before reporting. */
    export async function run() {
      await writeFile(${JSON.stringify(started)}, 'first');
      for (let attempt = 0; attempt < 400; attempt++) {
        if (await access(${JSON.stringify(release)}).then(() => true, () => false)) return { summary: 'First version' };
        await delay(25);
      }
      throw new Error('The test did not release the first version');
    }
  `)));
  const originalRun = await f.runNow(initial.id);
  await eventually(() => existsSync(started), Boolean);
  const draft = await f.save(initial, summaryBundle(schedule, 'Second version'));
  assert.equal(draft.awaitingEnable, true);
  assert.equal(draft.live?.digest, initial.latest.digest);
  assert.notEqual(draft.latest.digest, initial.latest.digest);
  const active = await f.enable(draft);
  assert.equal(active.awaitingEnable, false);
  assert.equal(active.live?.digest, draft.latest.digest);
  writeFileSync(release, '');
  const first = await eventually(() => f.runs(initial.id), rows => rows[0]?.state === 'done');
  assert.equal(first[0]?.number, originalRun.number);
  assert.equal(first[0]?.digest, initial.latest.digest);
  assert.equal(first[0]?.summary, 'First version');

  const next = await f.runNow(initial.id);
  const rows = await eventually(() => f.runs(initial.id), entries => entries[0]?.number === next.number && entries[0]?.state === 'done');
  assert.equal(rows[0]?.digest, draft.latest.digest);
  assert.equal(rows[0]?.summary, 'Second version');
});

test('two-stage previews substitute task creation and follow the exact inspected files into the saved version',
  { timeout: 20_000 }, async t => {
    const f = await fixture(t);
    const files = bundle({ ...schedule, limits: { ...schedule.limits, tasksPerRun: 1 } }, `
      /** Select one example. */
      export async function trigger() { return { run: true, reason: 'Selected the example' }; }
      /** Create a follow-up task. */
      export async function run({ alp }) {
        const task = await alp.tasks.create({ title: 'Preview-only task', request: false });
        return { summary: task.preview ? 'A task would be created' : 'Created a task' };
      }
    `);
    const taskCount = () => bundleNowRead(f.root, db => db.prepare('SELECT count(*) AS count FROM tasks').get()!.count);
    const before = taskCount();
    const inspect = async (run: boolean) => automationProgramPreviewResultSchema.parse(await f.request('preview', {
      under: f.project, files, run,
    })).preview;
    const triggerOnly = await inspect(false);
    assert.equal(triggerOnly?.trigger?.reason, 'Selected the example');
    assert.deepEqual(triggerOnly?.operations, []);
    const full = await inspect(true);
    assert.ok(full);
    assert.equal(full.outcome.summary, 'A task would be created');
    assert.deepEqual(full.operations.map(op => [op.name, op.replaced, op.result]), [
      ['tasks.create', true, { id: 'preview-1', preview: true }],
    ]);
    assert.equal(taskCount(), before);

    const saved = await f.create('Previewed follow-up', files);
    assert.equal(saved.latest.preview?.hash, full.hash);
    assert.equal(saved.latest.preview?.outcome.summary, 'A task would be created');
    assert.equal(taskCount(), before);
  });
