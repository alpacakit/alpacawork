import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { receiveSignal } from '@alpacawork/backend/test-dist/automations/signals.js';
import { startServer } from '@alpacawork/backend/test-dist/receiver/server.js';
import { CLI_CONTRACT, CONTRACT_HEADER } from '@alpacawork/contract/client-contract';
import { RESTORE_HEADER } from '@alpacawork/contract/recovery';
import {
  automationProgramRunReceiptSchema, automationProgramRunViewSchema, automationProgramRunsViewSchema,
  automationProgramViewResultSchema, automationProgramSaveResultSchema, type AutomationConfig,
} from '@alpacawork/contract/automation-program';
import { ControlStore } from '@alpacawork/db';
import { parse, stringify } from 'yaml';
import { installAgentStub } from './helpers/agent-stub.ts';
import { commandFetch } from './helpers/command-fetch.ts';
import { taskFlow } from './task-flow.fixture.ts';

const scheduled = { event: 'schedule', where: { cron: '0 3 1 1 *' } } as const;
const reader = { agent: 'claude', model: 'haiku', effort: 'low' } as const;

async function waitFor<T>(read: () => T | undefined | Promise<T | undefined>, description: string): Promise<T> {
  const expires = performance.now() + 10_000;
  do {
    const result = await read();
    if (result !== undefined) return result;
    await sleep(40);
  } while (performance.now() < expires);
  assert.fail(`Timed out waiting for ${description}`);
}

async function operationFixture(t: TestContext) {
  const previousPath = process.env.PATH;
  const previousConfig = process.env.XDG_CONFIG_HOME;
  const fixture = await taskFlow(t);
  const executable = join(fixture.root, 'claude-fixture.sh');
  writeFileSync(executable, '#!/bin/sh\nif [ "$1" = --version ]; then printf "2.1.330 (Claude Code)\\n"; else exit 1; fi\n', { mode: 0o700 });
  process.env.PATH = installAgentStub(fixture.root, 'claude', [executable]);
  process.env.XDG_CONFIG_HOME = join(fixture.root, 'user-config');
  t.after(() => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousConfig === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousConfig;
  });
  const config = join(fixture.root, 'config.yaml');
  const settings = parse(readFileSync(config, 'utf8'));
  writeFileSync(config, stringify({ ...settings, agents: { ...settings.agents, claude: {} } }));
  const aiCalls: string[] = [];
  const server = await startServer(fixture.root, 0, {
    hostSource: { supported: false, platform: 'test' },
    automationJudge: async (_executable, input) => {
      const material = JSON.parse(input);
      if (material.files) {
        return { kind: 'answer', model: 'synthetic-reviewer', text: JSON.stringify({ state: 'ok', summary: 'Reviewed', findings: [] }) };
      }
      aiCalls.push(material.prompt);
      return { kind: 'answer', model: 'synthetic-reader', text: 'Synthetic answer' };
    },
  });
  const url = (command: string, fields: Record<string, string> = {}) => {
    const target = new URL(`/api/commands/automation/${command}`, server.url);
    target.search = new URLSearchParams(fields).toString();
    return target;
  };
  const post = (command: string, fields: Record<string, unknown>, headers: Record<string, string> = {}) =>
    commandFetch(url(command), { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(fields) });
  const json = async (response: Promise<Response>) => {
    const result = await response;
    const body = await result.text();
    assert.equal(result.status, 200, body);
    return JSON.parse(body);
  };
  const getAutomation = (automation: string) => json(fetch(url('get', { automation }))).then(automationProgramViewResultSchema.parse);
  const recentRuns = (automation: string) => json(fetch(url('runs', { automation }))).then(automationProgramRunsViewSchema.parse);
  const readRun = (automation: string, number: number) => json(fetch(url('run', { automation, number: String(number) })))
    .then(automationProgramRunViewSchema.parse);
  const enable = async (name: string, configuration: AutomationConfig, functions: string) => {
    const result = automationProgramSaveResultSchema.parse(await json(post('new', { under: fixture.project, name, files: [{ path: 'main.ts',
      source: `export const config = ${JSON.stringify(configuration)};\n${functions}`,
    }] })));
    const { id, hash } = result.automation;
    const enabled = automationProgramViewResultSchema.parse(await json(post('enable', { automation: id, expectedHash: hash, acknowledgeReview: true })));
    assert.equal(enabled.automation.enabled, true);
    return id;
  };
  const runNow = async (automation: string, ref: string) => {
    const at = new Date().toISOString();
    const receipt = await json(post('run-now', { automation, syntheticEvent: { kind: 'schedule', ref, at, manual: true, scheduledAt: at } }));
    return automationProgramRunReceiptSchema.parse(receipt).run.number;
  };
  const finished = (automation: string, number: number) => waitFor(async () => {
    const result = await readRun(automation, number);
    return result.run.finishedAt ? result : undefined;
  }, `automation ${automation} run ${number} to finish`);
  const close = async () => {
    try { await server.close(); }
    finally {
      // The production cache's immutable directories need to be writable for fixture cleanup.
      const cache = join(fixture.root, '.automations');
      if (existsSync(cache)) {
        for (const entry of readdirSync(cache, { recursive: true, withFileTypes: true })) {
          if (entry.isDirectory()) chmodSync(join(entry.parentPath, entry.name), 0o700);
        }
      }
    }
  };
  return { ...fixture, aiCalls, close, post, json, getAutomation, recentRuns, readRun, enable, runNow, finished };
}

test('uncaught SDK limits skip the trigger or stop the run without making the automation fail', async t => {
  const f = await operationFixture(t);
  try {
    const triggerLimited = await f.enable('Limit before action', { on: scheduled, limits: { perDay: 10, aiCallsPerDay: 1 }, uses: { ai: { reader } } }, `
/** Read two answers before starting. */
export async function trigger({ alp }) {
  await alp.ai.ask({ ai: 'reader', prompt: 'First answer' });
  await alp.ai.ask({ ai: 'reader', prompt: 'Second answer' });
  return { run: true, reason: 'Ready' };
}
/** Record the result. */
export function run() { return { summary: 'Ran' }; }
`);
    const { run: skipped } = await f.finished(triggerLimited, await f.runNow(triggerLimited, 'trigger limit'));
    assert.equal(skipped.state, 'skipped', skipped.reason ?? undefined);
    assert.equal(skipped.reasonKind, 'limit:ai.ask');
    assert.equal(skipped.runStartedAt, null);
    assert.deepEqual(f.aiCalls, ['First answer']);

    const runLimited = await f.enable('Limit during action', { on: scheduled, limits: { perDay: 10, tasksPerRun: 0 } }, `
/** Try to make a task beyond the allowance. */
export async function run({ alp }) {
  await alp.tasks.create({ title: 'Beyond the allowance', request: false });
  return { summary: 'Ran' };
}
`);
    for (let number = 1; number <= 3; number++) {
      const { run } = await f.finished(runLimited, await f.runNow(runLimited, `run limit ${number}`));
      assert.equal(run.state, 'stopped', run.reason ?? undefined);
      assert.equal(run.reasonKind, 'limit:tasks.create');
      assert.notEqual(run.runStartedAt, null);
    }
    for (const automation of [triggerLimited, runLimited]) {
      const view = (await f.getAutomation(automation)).automation;
      assert.equal(view.enabled, true);
      assert.deepEqual(view.attention, []);
    }
  } finally { await f.close(); }
});

test('the SDK confines names and writes to the current grant and revokes it when the automation is disabled', async t => {
  const f = await operationFixture(t);
  try {
    const credential = join(f.root, 'synthetic-operation-credential.json');
    const automation = await f.enable('Check operation grants', { on: scheduled, limits: { perDay: 10, tasksPerRun: 1 } }, `
import { writeFile } from 'node:fs/promises';
/** Try an undeclared AI and a write before the action. */
export async function trigger({ alp }) {
  const refusals = [];
  try { await alp.ai.ask({ ai: 'undeclared', prompt: 'Unused' }); }
  catch (error) { refusals.push(error.code); }
  try { await alp.tasks.create({ title: 'Blocked during trigger', request: false }); }
  catch (error) { refusals.push(error.code); }
  return { run: true, reason: refusals.join(',') };
}
/** Lend the synthetic credential to the test while the action is active. */
export async function run({ signal }) {
  const credential = { token: process.env.ALPACAWORK_PROGRAM_TOKEN, restoreId: process.env.ALPACAWORK_PROGRAM_RESTORE_ID };
  await writeFile(${JSON.stringify(credential)}, JSON.stringify(credential), { mode: 0o600 });
  if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
  return { summary: 'Ran' };
}
`);
    const number = await f.runNow(automation, 'scope check');
    const { token, restoreId } = await waitFor(() => {
      if (!existsSync(credential)) return undefined;
      const raw = readFileSync(credential, 'utf8');
      return raw ? JSON.parse(raw) : undefined;
    }, 'the active operation credential');
    const headers = { Authorization: `Alpacawork-Program ${token}`, 'X-Alpacawork-Client': 'cli',
      [CONTRACT_HEADER]: String(CLI_CONTRACT), [RESTORE_HEADER]: restoreId };
    const active = await f.readRun(automation, number);
    assert.equal(active.run.trigger?.reason, 'forbidden,forbidden');
    assert.deepEqual(f.aiCalls, []);
    const list = await f.json(f.post('operate', { operation: 'tasks.list', input: {} }, headers));
    assert.ok(Array.isArray(list.tasks));
    assert.ok(!list.tasks.some((task: { title: string }) => task.title === 'Blocked during trigger'));

    const disabled = await f.json(f.post('disable', { automation }));
    assert.equal(disabled.automation.enabled, false);
    const denied = await f.post('operate', { operation: 'tasks.create', input: { title: 'Blocked after disabling', request: false } }, headers);
    assert.equal(denied.status, 403, await denied.text());
    const { run } = await f.finished(automation, number);
    assert.equal(run.state, 'stopped', run.reason ?? undefined);
  } finally { await f.close(); }
});

test('a waiting signal run receives the total count and only the twenty newest items', async t => {
  const f = await operationFixture(t);
  try {
    const automation = await f.enable('Collect signal deliveries', { on: { event: 'signal' }, limits: { perDay: 10 } }, `
/** Report the aggregate count and the delivered item order. */
export function run({ event }) {
  return { summary: String(event.count), report: JSON.stringify(event.items.map(item => item.data.number)) };
}
`);
    const store = new ControlStore(f.root);
    const now = Date.now();
    try {
      // Submit an already admitted batch so receiver rate limiting and the worker tick cannot split it.
      store.write(db => {
        for (let number = 1; number <= 21; number++) {
          receiveSignal(db, { automation, data: { number } }, { kind: 'human' }, randomUUID(), new Date(now - 21 + number));
        }
      });
    } finally { store.close(); }
    const number = await waitFor(async () => (await f.recentRuns(automation)).runs[0]?.number, 'the waiting signal run');
    const { run, event } = await f.finished(automation, number);
    const newest = Array.from({ length: 20 }, (_, index) => 21 - index);
    assert.equal(run.state, 'done', run.reason ?? undefined);
    assert.equal(run.summary, '21');
    assert.deepEqual(JSON.parse(run.report!), newest);
    assert.equal(event?.kind, 'signal');
    if (event?.kind !== 'signal') assert.fail('Expected a retained signal event');
    assert.equal(event.count, 21);
    assert.deepEqual(event.items.map(item => item.data), newest.map(value => ({ number: value })));
    assert.equal((await f.recentRuns(automation)).runs.length, 1);
  } finally { await f.close(); }
});

test('waiting for the previous run leaves unrequested rolling tasks usable and waits for requested tasks', async t => {
  const f = await operationFixture(t);
  try {
    const automation = await f.enable('Keep one findings task', {
      on: scheduled, limits: { perDay: 10, waitForPrevious: true, tasksPerRun: 1 }, uses: { ai: { reader } },
    }, `
/** Add findings to a rolling task or request a review. */
export async function run({ event, alp }) {
  if (event.ref === 'request') {
    const task = await alp.tasks.create({ title: 'Review findings', ai: 'reader', instruction: 'Review the findings.' });
    return { summary: task.id };
  }
  const { tasks } = await alp.tasks.list({ createdByThis: true, title: 'Findings' });
  const task = tasks[0] ?? await alp.tasks.create({ title: 'Findings', request: false });
  await alp.tasks.comment({ task: task.id, title: 'Finding', description: event.ref });
  return { summary: task.id };
}
`);
    const { run: first } = await f.finished(automation, await f.runNow(automation, 'First finding'));
    assert.equal(first.state, 'done', first.reason ?? undefined);
    const rollingTask = first.summary!;
    assert.equal(await f.state(rollingTask), 'todo');
    const { run: second } = await f.finished(automation, await f.runNow(automation, 'Second finding'));
    assert.equal(second.state, 'done', second.reason ?? undefined);
    assert.equal(second.summary, rollingTask);
    const notes = (await f.get(rollingTask)).meta.log.flatMap(entry => entry.kind === 'reported' && entry.title === 'Finding' ? [entry.description] : []);
    assert.deepEqual(notes, ['First finding', 'Second finding']);

    const { run: requested } = await f.finished(automation, await f.runNow(automation, 'request'));
    assert.equal(requested.state, 'done', requested.reason ?? undefined);
    assert.notEqual(requested.summary, rollingTask);
    const { run: next } = await f.finished(automation, await f.runNow(automation, 'Third finding'));
    assert.equal(next.state, 'skipped');
    assert.ok(next.reasonKind === 'previous_task_active' || next.reasonKind === 'previous_task_failed', next.reasonKind ?? undefined);
    assert.equal(next.runStartedAt, null);
  } finally { await f.close(); }
});
