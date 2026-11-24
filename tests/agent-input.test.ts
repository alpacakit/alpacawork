import { preserveTestFailure } from './helpers/failure-workspace.ts';
import { ReturnLifecycle, returnDisposition } from '@alpacawork/backend/test-dist/control/return-lifecycle.js';
import { insertReturnFact } from './helpers/return-facts.ts';
import { RunEventImporter } from '@alpacawork/backend/test-dist/runs/event-importer.js';
import { grantFixtureRequest, initializeControlFixture } from './helpers/control-fixture.ts';
/** Instructions sent while an agent works reach its stdin, or wait for the next Run; built manager, fake agent only. */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { stringify } from 'yaml';
import { RunStore, type CreateRunFields, type RunTransaction } from '@alpacawork/runs';
import type { RunRecord } from '@alpacawork/contract/run';
import { bridgeInput as input } from '@alpacawork/backend/test-dist/agents/adapters/bridge.js';
import { fixtureAgentSetting, installAgentStub } from './helpers/agent-stub.ts';
import { FileWriter } from '@alpacawork/backend/test-dist/raw/storage.js';
import { ControlTaskCommands } from '@alpacawork/backend/test-dist/control/task-commands.js';
import { PlacementStore } from '@alpacawork/backend/test-dist/control/placements.js';
import { TaskRepository } from '@alpacawork/backend/test-dist/control/task-store.js';
import { launchSnapshot, readAgentsSettings } from '@alpacawork/backend/test-dist/agents-settings.js';
import { settle } from '@alpacawork/backend/test-dist/runs/scheduler.js';
import { AgentInputChannel } from '@alpacawork/backend/test-dist/runs/input.js';
import { ReturnRouter } from '@alpacawork/backend/test-dist/control/return-router.js';
import { installInputManagerClock } from './fixtures/input-manager-clock.ts';
import { RUN_FILES } from '@alpacawork/contract/run';
import type { Problem } from '@alpacawork/core';
import { withControlWrite } from '@alpacawork/backend/test-dist/control/task-transition.js';
import { latestCompactions, requestCompaction } from '@alpacawork/backend/test-dist/runs/compactions.js';
import { readControl } from '@alpacawork/backend/test-dist/control/task-store.js';

const fake = join(import.meta.dirname, 'fixtures/fake-input-agent.mjs');
async function until<T>(check: () => T | null | undefined | false, message: string, timeout = 12_000): Promise<T> {
  const deadline = performance.now() + timeout;
  for (;;) {
    const value = check(); if (value) return value;
    if (performance.now() >= deadline) throw new Error(`Deadline: ${message}`);
    await delay(20);
  }
}

test('the input line fills {prompt} and {input} and the channel closes once the work after the last taken input ends', () => {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'alpacawork-input-')));
  try {
    const stdin = new PassThrough(), written: string[] = [];
    stdin.on('data', chunk => written.push(...String(chunk).trim().split('\n')));
    const channel = new AgentInputChannel(stdin, input);
    const out = (...events: object[]) => writeFileSync(join(folder, RUN_FILES.stdout),
      `${readOr(join(folder, RUN_FILES.stdout))}${events.map(event => `${JSON.stringify(event)}\n`).join('')}`);
    writeFileSync(join(folder, RUN_FILES.stdout), '');
    assert.ok(channel.write('R1', 'first {input} "quoted"'));
    const first = JSON.parse(written[0]!);
    assert.equal(first.text, 'first {input} "quoted"');
    assert.match(first.id, /^[0-9a-f-]{36}$/);
    out({ type: 'input.taken', id: first.id });
    assert.deepEqual(summary(channel.poll(folder, null)), { taken: ['R1'], refused: [] });
    channel.write('R2', 'second'); channel.write('R3', 'third');
    const [second, third] = written.slice(1).map(line => JSON.parse(line));
    // A round that ends while an instruction is unanswered keeps the input open for it.
    out({ type: 'input.taken', id: second.id }, { type: 'turn.completed' });
    assert.deepEqual(summary(channel.poll(folder, null)), { taken: ['R2'], refused: [] });
    assert.equal(channel.open, true);
    out({ type: 'input.not_sent', evidence: 'transfer_not_started', id: third.id });
    assert.deepEqual(summary(channel.poll(folder, null)), { taken: [], refused: ['R3'] });
    assert.equal(channel.open, false);
    assert.equal(channel.refused('R3'), true);
    assert.equal(channel.write('R4', 'late'), false);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});
const summary = ({ receipts: _receipts, ...value }: ReturnType<AgentInputChannel['poll']>) => value;
const readOr = (path: string) => existsSync(path) ? readFileSync(path, 'utf8') : '';

test('async write errors identify failed instructions and a taken receipt always wins', async () => {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'alpacawork-input-error-')));
  const failure = Object.assign(new Error('broken pipe'), { code: 'EPIPE' });
  try {
    const stdin = new Writable({ write(chunk, _encoding, done) {
      const line = JSON.parse(String(chunk));
      if (line.text === 'first') done();
      else setImmediate(() => done(failure));
    } });
    const channel = new AgentInputChannel(stdin, input);
    const stdout = join(folder, RUN_FILES.stdout);
    writeFileSync(stdout, '');
    channel.write('R1', 'first', 'input-first');
    writeFileSync(stdout, JSON.stringify({ type: 'input.taken', id: 'input-first' }) + '\n');
    channel.poll(folder, null);
    channel.write('R2', 'already taken', 'input-taken');
    channel.write('R3', 'cannot be written', 'input-failed');
    writeFileSync(stdout, JSON.stringify({ type: 'input.taken', id: 'input-taken' }) + '\n', { flag: 'a' });
    await until(() => !channel.open, 'asynchronous input error');
    assert.deepEqual(summary(channel.poll(folder, null)), { taken: ['R2'], refused: [] });
    assert.deepEqual(summary(channel.poll(folder, null)), { taken: [], refused: [] });
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('closure alone does not declare a successfully written instruction undelivered', () => {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'alpacawork-input-closed-')));
  try {
    writeFileSync(join(folder, RUN_FILES.stdout), '');
    const stdin = new PassThrough(), channel = new AgentInputChannel(stdin, input);
    channel.write('R1', 'possibly taken', 'uncertain');
    channel.close();
    assert.deepEqual(summary(channel.poll(folder, null)), { taken: [], refused: [] });
    writeFileSync(join(folder, RUN_FILES.stdout), JSON.stringify({ type: 'input.taken', id: 'uncertain' }) + '\n');
    assert.deepEqual(summary(channel.poll(folder, null)), { taken: ['R1'], refused: [] });
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

async function setup(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'alpacawork-steer-')));
  const restoreClock = installInputManagerClock();
  t.after(restoreClock);
  const writer = new FileWriter(root);
  let project: string;
  try { project = initializeControlFixture(root); } finally { writer.close(); }
  const taskId: string = (await new ControlTaskCommands(root, { kind: 'human' }).create({ parentId: project,
    userRequested: null, tasks: [{ title: 'Steer fixture' }] })).tasks[0].id;
  const people = new PlacementStore(root);
  let placementId: string;
  try { placementId = people.createAndPlace({ taskId, profileKey: 'steer', responsible: true }).placement.id; }
  finally { people.close(); }
  const path = installAgentStub(root, 'alpacawork-agent', [process.execPath, fake, '--root', root]);
  writeFileSync(join(root, 'config.yaml'), stringify({ limits: { parallel: 4, run_minutes: 0 },
    agents: { steer: fixtureAgentSetting('codex') } }));
  const store = new RunStore(root, { busyTimeoutMs: 3000 });
  t.after(async () => {
    try {
      await preserveTestFailure(t, root);
      const mine = () => execFileSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).split('\n')
        .filter(line => line.includes(root)).map(line => Number(line.trim().split(/\s+/)[0]));
      for (const pid of mine()) try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
      await until(() => mine().length === 0, 'test processes gone', 5000);
    } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
  });
  /** One Request and its Run, as admission records them; a later one continues the conversation. */
  const send = (plan: object, extra: Partial<CreateRunFields> = {}, purpose: 'instruction' | 'return_continuation' = 'instruction') => store.write(tx => {
    const settings = readAgentsSettings(root);
    if (!settings.ok) throw settings.error;
    const head = tx.conversationHead(placementId);
    const snapshot = launchSnapshot(settings.config, 'steer', head ? 'resume' : 'start', path, {}, head?.launch);
    if (!snapshot.ok) throw new Error(snapshot.code);
    const requestId = randomUUID();
    tx.insertRequest({ id: requestId, taskId, placementId, placementRevision: 1, taskHash: '0'.repeat(64),
      waitCycleId: null, headRunId: head?.id ?? null, mode: head ? 'continue' : 'new', body: JSON.stringify(plan), purpose,
      author: purpose === 'return_continuation' ? { kind: 'placement', placementId } : { kind: 'human' }, submittedAt: new Date().toISOString(), deliveryState: head ? 'waiting_for_run' : 'queued' });
    grantFixtureRequest(store, tx, requestId);
    const run = tx.create({ task: taskId, agent: 'steer', role: 'owner', placementId, requestId, resumes: head?.id ?? null,
      continues: false, session: head?.session ?? null, caller: null, cwd: root, launch: snapshot.launch, ...extra }, JSON.stringify(plan));
    writeFileSync(join(root, `clock-${run.id}`), '0');
    return run;
  });
  const tick = async () => { const s = new RunStore(root, { busyTimeoutMs: 3000 }); try { return await settle(s); } finally { s.close(); } };
  const release = (name: string) => writeFileSync(join(root, name), 'go');
  const notes = () => readOr(join(root, 'input-agent.jsonl')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  const advance = async (steps = 1) => {
    new RunEventImporter(store).pass();
    await tick();
    new RunEventImporter(store).pass();
    for (let step = 0; step < steps; step++) {
      for (const run of store.read().filter(run => run.state === 'running')) {
        const clock = join(root, `clock-${run.id}`), ack = `${clock}.ack`;
        await until(() => existsSync(ack) || store.get(run.id)?.state !== 'running',
          `${run.id} manager clock ready`);
        if (store.get(run.id)?.state !== 'running') continue;
        const next = Number(readOr(clock)) + 1;
        writeFileSync(clock, String(next));
        await until(() => {new RunEventImporter(store).pass();return Number(readOr(ack)) >= next || store.get(run.id)?.state !== 'running'},
          `${run.id} clock tick acknowledged`);
        await tick();
      }
    }
  };
  const wait = async <T>(check: () => T | null | undefined | false, message: string): Promise<T> => {
    const deadline = performance.now() + 12_000;
    for (;;) {
      const value = check(); if (value) return value;
      if (performance.now() >= deadline) throw new Error(`Deadline: ${message}`);
      await advance();
      await delay(20); // Yield to the real agent's IO, not the manager's clock.
    }
  };
  const state = (run: RunRecord, wanted: RunRecord['state']) => wait(() => {
    const latest = store.get(run.id); return latest?.state === wanted && latest;
  }, `${run.id} becomes ${wanted}`);
  return { root, taskId, placementId, store, send, tick, release, notes, state, advance, until: wait };
}

test('an instruction chosen to start with other launch values waits for the working Run instead of joining it', async t => {
  const h = await setup(t);
  const first = h.send({ gate: 'first' });
  await h.tick();
  await h.until(() => h.notes().some(note => note.taken === JSON.stringify({ gate: 'first' })), 'first instruction taken');
  // As admission records a continuation with another effort chosen.
  const second = h.send({ step: 'second' }, { launch: { ...first.launch, values: { ...first.launch.values, effort: 'max' } } });
  await h.advance(5);
  assert.equal(h.store.get(second.id)!.state, 'queued');
  assert.equal(h.notes().some(note => note.taken === JSON.stringify({ step: 'second' })), false);
  h.release('first');
  await h.state(first, 'succeeded');
  await h.tick();
  const own = await h.until(() => { const run = h.store.get(second.id); return run && run.state !== 'queued' && run; }, 'second starts its own Run');
  assert.notEqual(own.state, 'joined');
  assert.equal(own.launch.values.effort, 'max');
});

test('an instruction sent while the agent works joins its Run, and the Run ends with one reply', async t => {
  const h = await setup(t);
  const first = h.send({ gate: 'first' });
  await h.tick();
  await h.until(() => h.notes().some(note => note.taken === JSON.stringify({ gate: 'first' })), 'first instruction taken');
  const second = h.send({ step: 'second' });
  const joined = await h.state(second, 'joined');
  assert.equal(joined.into, first.id);
  assert.deepEqual(joined.pids, { manager: null, agent: null });
  assert.equal(h.store.getRequest(second.requestId)?.deliveryState, 'queued');
  assert.equal(h.store.getText(second.id)?.resultState, 'missing');
  assert.equal(h.store.get(first.id)!.state, 'running');
  // The next instruction continues from the Run doing the work, never from a joined one.
  assert.equal(h.store.conversationHead(first.placementId)?.id, first.id);
  h.release('first');
  await h.state(first, 'succeeded');
  assert.equal(h.store.getText(first.id)?.result, `reply to ${JSON.stringify({ gate: 'first' })}`);
  const agents = new Set(h.notes().filter(note => note.started).map(note => note.pid));
  assert.equal(agents.size, 1, 'one agent process did both instructions');
  assert.deepEqual(h.notes().filter(note => note.taken).map(note => note.taken),
    [JSON.stringify({ gate: 'first' }), JSON.stringify({ step: 'second' })]);
});

test('an instruction the agent refuses waits and runs next as the continued conversation, keeping order', async t => {
  const h = await setup(t);
  const first = h.send({ gate: 'first' });
  await h.tick();
  await h.until(() => h.notes().some(note => note.taken), 'first instruction taken');
  const refused = h.send({ refuse: true, gate: 'again' });
  await h.until(() => h.notes().some(note => note.refused), 'refused');
  const after = h.send({ step: 'after' });
  await h.advance(2);
  // The one sent after a refused instruction does not jump ahead of it.
  assert.equal(h.store.get(after.id)!.state, 'queued');
  assert.equal(h.store.get(refused.id)!.state, 'queued');
  h.release('first');
  await h.state(first, 'succeeded');
  await h.tick();
  const running = await h.state(refused, 'running');
  assert.equal(running.resumes, first.id);
  // The continued Run takes the waiting instruction in as before.
  await h.state(after, 'joined');
  h.release('again');
  await h.state(refused, 'succeeded');
  assert.equal(h.store.get(after.id)!.into, refused.id);
});

test('once the work has ended and stdin is closed, an instruction waits for the next Run', async t => {
  const h = await setup(t);
  const first = h.send({ gate: 'first', linger: 'exit' });
  await h.tick();
  await h.until(() => h.notes().some(note => note.taken), 'first instruction taken');
  h.release('first');
  await h.until(() => h.notes().some(note => note.stdin === 'closed'), 'stdin closed after the work ended');
  const late = h.send({ step: 'late' });
  await h.advance(2);
  assert.equal(h.store.get(first.id)!.state, 'running');
  assert.equal(h.store.get(late.id)!.state, 'queued');
  h.release('exit');
  await h.state(first, 'succeeded');
  await h.tick();
  await h.state(late, 'succeeded');
  assert.equal(h.store.get(late.id)!.resumes, first.id);
});

test('a compaction asked for an idle conversation goes first with its next instruction, and its outcome shows', async t => {
  const h = await setup(t);
  const ask = (instructions: string | null) => withControlWrite(h.root, (_tx, db) => requestCompaction(db,
    { taskId: h.taskId, placementId: h.placementId, instructions, at: new Date().toISOString(), nextValues: () => null }));
  const refusal = (instructions: string | null) => { try { ask(instructions); } catch (error) { return (error as Problem).reason?.kind; } };
  assert.equal(refusal(null), 'compaction_without_conversation');
  const first = h.send({ step: 'first' });
  await h.tick();
  await h.state(first, 'succeeded');
  assert.equal(refusal('Keep the plan'), 'compaction_instructions_unsupported', 'Codex compacts without instructions');
  const asked = ask(null);
  assert.equal(asked.state, 'pending');
  const next = h.send({ step: 'next' });
  await h.tick();
  await h.state(next, 'succeeded');
  const resumed = h.notes().filter(note => note.compacted !== undefined || note.taken).map(note => note.taken ?? 'compacted');
  assert.deepEqual(resumed, [JSON.stringify({ step: 'first' }), 'compacted', JSON.stringify({ step: 'next' })]);
  assert.equal(h.store.getText(next.id)?.result, `reply to ${JSON.stringify({ step: 'next' })}`, 'the Run replies to its instruction');
  const shown = readControl(h.root, db => latestCompactions(db, [h.placementId]).get(h.placementId));
  assert.equal(shown?.state, 'compacted');
});

test('a return continuation joins the working agent, closes its return, and is not sent twice', async t => {
  const h = await setup(t);
  const first = h.send({ gate: 'first' });
  await h.tick();
  await h.until(() => h.notes().some(note => note.taken), 'first instruction taken');
  // A return closes a Request the seat sent: here its working Run's Request to a member, whose worker Run ended.
  const people = new PlacementStore(h.root);
  let memberId: string;
  try { memberId = people.createAndPlace({ taskId: h.taskId, profileKey: 'steer', responsible: false }).placement.id; }
  finally { people.close(); }
  // The Task's return facts, as RequestService reads them for an admission.
  const lifecycle = (tx: RunTransaction) => { const tasks = new TaskRepository(h.root, h.store.connection);
    return new ReturnLifecycle(h.store.connection, tx, tasks.related(h.taskId).tasks, tasks.projectFor(h.taskId)); };
  h.store.write(tx => {
    const at = new Date().toISOString(), requestId = randomUUID(), waitCycleId = lifecycle(tx).cycleFor(h.taskId);
    tx.insertRequest({ id: requestId, taskId: h.taskId, placementId: memberId, placementRevision: 1, taskHash: '0'.repeat(64),
      waitCycleId, headRunId: null, mode: 'new', body: 'member work', purpose: 'instruction',
      author: { kind: 'placement', placementId: h.placementId }, submittedAt: at, deliveryState: 'queued' });
    const worker = tx.create({ task: h.taskId, agent: 'steer', role: 'worker', placementId: memberId, requestId, resumes: null,
      continues: false, session: null, caller: { run: first.id }, cwd: h.root, launch: first.launch }, 'member work');
    tx.update({ ...worker, state: 'running', started_at: at });
    tx.finish({ ...tx.get(worker.id)!, state: 'succeeded', ended_at: at }, { state: 'present', text: 'member reply' });
    insertReturnFact(h.store.connection, { id: 'RET-agent-input', requestId, boundaryRunId: worker.id, outcome: 'succeeded',
      toTaskId: h.taskId, causeLogId: null, createdAt: at });
  });
  // The seat's own continuation reserves the returns it was drawn from, as its admission does.
  const wake = h.send({ step: 'wake' }, {}, 'return_continuation');
  assert.equal(h.store.write(tx => lifecycle(tx).reserve(['RET-agent-input'], wake.requestId)), true);
  const joined = await h.state(wake, 'joined');
  assert.equal(joined.into, first.id);
  assert.equal(returnDisposition(h.store.readReturns().find(row => row.id === 'RET-agent-input')!), 'in_flight');
  await new ReturnRouter(h.root).pass();
  assert.equal(returnDisposition(h.store.readReturns().find(row => row.id === 'RET-agent-input')!), 'in_flight');
  assert.ok(h.store.readReturns().find(row => row.id === 'RET-agent-input')!.deliveries[0]!.receivedAt);
  assert.deepEqual((await new ReturnRouter(h.root).pass()).acceptedRequestIds, []);
  h.release('first');
  await h.state(first, 'succeeded');
});
