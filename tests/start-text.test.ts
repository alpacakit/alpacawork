import { fixtureAgentSetting } from './helpers/agent-stub.ts';
import { stringify } from 'yaml';
import { initializeControlFixture } from './helpers/control-fixture.ts';
/**
 * The start text a Run is delivered: the message whole, then the project policy and the other parts that fit the prompt
 * limit (the Task's and its parent's context, child changes, carried returns, open work and estimate examples), each
 * else as the command that reads it; a continuation keeps the current context and questions as well as new events.
 * Every value comes from the Tasks' values as task-context renders them, the text the context tab shows.
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { RunStore } from '@alpacawork/runs';
import { PROTOCOL_LIMITS } from '@alpacawork/contract/run-protocol';
import { MAX_INSTRUCTION_BYTES } from '@alpacawork/raw';
import { FileWriter } from '@alpacawork/backend/test-dist/raw/storage.js';
import { ControlTaskCommands } from '@alpacawork/backend/test-dist/control/task-commands.js';
import { ControlTaskStore, TaskTree, controlSnapshotView, readControl } from '@alpacawork/backend/test-dist/control/task-store.js';
import { readContextFacts, taskContexts } from '@alpacawork/backend/test-dist/control/task-context.js';
import { writeTaskValues } from '@alpacawork/backend/test-dist/control/task-values-store.js';
import { ControlStore } from '@alpacawork/db';
import { DEFAULT_SCHEMA, fieldCatalog, renderContext, type TaskValues } from '@alpacawork/contract';
import { PlacementStore } from '@alpacawork/backend/test-dist/control/placements.js';
import { RequestService } from '@alpacawork/backend/test-dist/control/requests.js';
import { TaskReportService } from '@alpacawork/backend/test-dist/control/report.js';
import { requestAuthor, startText, type LaunchSource, type StartTextInput } from '@alpacawork/backend/test-dist/control/start-text.js';
import type { ReturnLine } from '@alpacawork/backend/test-dist/control/return-lines.js';
import { languageLine } from '@alpacawork/backend/test-dist/receiver/person-state.js';

/** A launch profile that resumes its conversations and never runs: no server starts here, so no Run is launched. */
const AGENTS = stringify({ agents: { codex: fixtureAgentSetting('codex') } });
const POLICY = '## Project policy';
const CHANGES = '## Changes since the previous request (per child)';
const CHILDREN = '## Child tasks now (unfinished ones)';
const CARRIED = '## Carried over (arrived earlier, not yet handled)';

/** The Task's responsible placement, placed now (as a store write, which leaves the Task's hash) when it has none. */
function responsibleOf(root: string, taskId: string) {
  const people = new PlacementStore(root);
  try {
    return people.placements(taskId).find(placement => placement.responsible && placement.active)
      ?? people.createAndPlace({ taskId, profileKey: 'codex', responsible: true }).placement;
  } finally { people.close(); }
}
/**
 * The root project P1 and the test project below it (`project`), with Tasks made as a person makes them; a task that
 * gets children keeps its responsible, so it has one before they are made.
 */
async function workspace(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'alpacawork-start-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const writer = new FileWriter(root);
  let project: string;
  try { writer.save('config.yaml', null, Buffer.from(AGENTS)); project = initializeControlFixture(root); }
  finally { writer.close(); }
  const commands = new ControlTaskCommands(root, { kind: 'human' });
  const tasks = new ControlTaskStore(root);
  const create = async (title: string, parentId: string, kind: 'task' | 'project' = 'task') => {
    if (kind === 'task' && (await tasks.get(parentId)).meta.kind === 'task') responsibleOf(root, parentId);
    return (await commands.create({ kind, ...(kind === 'project' ? { color: '#39659b' } : {}), parentId, userRequested: kind === 'task' && (await tasks.get(parentId)).meta.kind === 'project', tasks: [{ title }] })).tasks[0].id;
  };
  /**
   * Replaces a Task's values whole, recorded as a change of its values (body_updated) as a write of values is. The
   * values go straight to the store so an oversized one can stand for what an old body held.
   */
  const write = async (id: string, values: TaskValues) => {
    const store = new ControlStore(root);
    try { store.write(db => writeTaskValues(db, id, values)); } finally { store.close(); }
    await commands.update({ id, values: {}, expectedTaskHash: (await tasks.get(id)).hash });
  };
  /** What a launch reads, as RequestService reads it at admission. */
  const source = async (): Promise<LaunchSource> => {
    const snapshot = await tasks.snapshot(), tree = new TaskTree(snapshot.tasks);
    return { tasks: controlSnapshotView(snapshot).tasks, tree, runRecords: [], errors: [],
      contexts: taskContexts(tree, readControl(root, db => readContextFacts(db, tree))) };
  };
  return { root, project, commands, tasks, create, write, source };
}
type Workspace = Awaited<ReturnType<typeof workspace>>;
/** A responsible's first request to `taskId`, as of `source`; `more` changes any of it. */
const launch = async (w: Workspace, taskId: string, more: Partial<StartTextInput> = {}) => startText({
  source: await w.source(), taskId, responsible: true, mode: 'new', at: '2026-10-19T00:00:00Z', body: 'Do the work',
  since: null, carried: [], ...more });
/** The section headings of a start text, in order. */
const headings = (prompt: string) => [...prompt.matchAll(/^## (.+)$/gm)].map(match => match[1]);
/** A Task's values as its context: what the context tab shows and a launch carries (default schema). */
const contextOf = (values: TaskValues) => renderContext(DEFAULT_SCHEMA, values, fieldCatalog([]));
/** `section`'s heading and lines, then a blank line, as the start text writes a section. */
const section = (heading: string, lines: readonly string[]) => `${heading}\n${lines.join('\n')}\n\n`;

test('the project policy section gives each project\'s summary and full policy, from the root down', async t => {
  const w = await workspace(t);
  const mobile = await w.create('Mobile', w.project, 'project');
  const quiet = await w.create('Quiet', mobile, 'project');
  const work = await w.create('Work', quiet);
  assert.equal(headings(await launch(w, work)).includes(POLICY.slice(3)), false);
  const root = 'Goal: ship the product.\n- Delegated scope: research and implementation are delegated\n- Do not touch production';
  await w.write('P1', { project_policy: root });
  await w.write(w.project, { project_policy: 'Ship a small increment', project_summary: 'Accounting and monthly close' });
  await w.write(mobile, { project_summary: 'Mobile releases\n and maintenance' });
  const chain = section(POLICY, ['Listed from the root project down.',
    `\n### alpacawork (P1)\n${root}`,
    `\n### Test project (${w.project})\nSummary: Accounting and monthly close\n\nShip a small increment`,
    `\n### Mobile (${mobile})\nSummary: Mobile releases and maintenance`]);
  const prompt = await launch(w, work);
  assert.ok(prompt.includes(chain), prompt);
  assert.equal(prompt.includes(`(${quiet})`), false);
  // A worker works under the same policy.
  assert.ok((await launch(w, work, { responsible: false })).includes(chain));
});

test('a project policy too long for the prompt becomes the command that reads it, and the prompt stays within its limit', async t => {
  const w = await workspace(t);
  const work = await w.create('Work', w.project);
  await w.write(w.project, { project_policy: 'p'.repeat(PROTOCOL_LIMITS.prompt) });
  for (const responsible of [true, false]) {
    const prompt = await launch(w, work, { responsible });
    assert.ok(Buffer.byteLength(prompt) <= PROTOCOL_LIMITS.prompt);
    assert.ok(prompt.includes(`${POLICY}\nToo large to include. Read the policies of ${w.project} with alpacawork task get --task`), prompt.slice(0, 600));
  }
});

test('a continuation repeats the project policy only when a project of the chain changed after the previous request', async t => {
  const w = await workspace(t);
  const work = await w.create('Work', w.project);
  await w.write(w.project, { project_policy: 'Ship a small increment' });
  await delay(5);
  const since = new Date().toISOString();
  await delay(5);
  const continued = await launch(w, work, { mode: 'continue', since });
  assert.deepEqual(headings(continued), ['Request']);
  assert.match(continued.split('\n')[0]!, /continuing the same conversation/);
  await w.commands.update({ id: w.project, values: { project_summary: 'Accounting releases' },
    expectedTaskHash: (await w.tasks.get(w.project)).hash });
  const changed = await launch(w, work, { mode: 'continue', since });
  assert.deepEqual(headings(changed), [POLICY.slice(3), 'Request']);
  assert.ok(changed.includes('Summary: Accounting releases\n\nShip a small increment'));
});

test('what changed below since the previous request is one line per child with a record its parent sees', async t => {
  const w = await workspace(t);
  const parent = await w.create('Parent', w.project);
  const stopped = await w.create('Stopped child', parent), edited = await w.create('Edited child', parent);
  await w.write(stopped, { conclusion: 'Option A is sufficient' });
  await delay(5);
  const since = new Date().toISOString();
  await delay(5);
  // The end of a child's work is its parent's to see; an edit of its values is not.
  await new TaskReportService(w.root).report({ task: stopped, state: 'stopped', title: 'Stop', opId: randomUUID(),
    expectedTaskHash: (await w.tasks.get(stopped)).hash }, { kind: 'human' }, { kind: 'human' });
  await w.write(edited, { notes: 'Rewritten body' });
  const prompt = await launch(w, parent, { mode: 'continue', since });
  assert.ok(prompt.includes(section(CHANGES, [`- Child task ${stopped} "Stopped child": state stopped; conclusion: Option A is sufficient`])), prompt);
  assert.equal(prompt.includes('Edited child'), false);
  // Nothing changed since a later request.
  assert.equal(headings(await launch(w, parent, { mode: 'continue', since: new Date().toISOString() })).includes(CHANGES.slice(3)), false);
  // A new conversation is told no difference, but each child not finished as it is now, by the same line.
  const opened = await launch(w, parent);
  assert.equal(headings(opened).includes(CHANGES.slice(3)), false);
  assert.ok(opened.includes(section(CHILDREN, [`- Child task ${edited} "Edited child": state todo`])), opened);
});

test('a child that entered error with no report, or stopped by a person, is a change its parent is told', async t => {
  const w = await workspace(t);
  const parent = await w.create('Parent', w.project);
  const child = await w.create('Silent child', parent);
  const since = new Date(Date.now() - 1000).toISOString(), at = new Date().toISOString();
  // The Task's Run ended its turn with no report: TaskTransition linked the Task to error. No Run is in trouble.
  const source = await w.source(), task = source.tree.byId.get(child)!;
  task.meta.log.push({ id: 'LENDR1', kind: 'linked', at, title: null, description: null, actor: { kind: 'human' },
    fromState: 'doing', toState: 'error', causeAt: at, runId: 'R1' });
  task.meta.baseState = 'error';
  const prompt = startText({ source, taskId: parent, responsible: true, mode: 'continue', at, body: 'Next', since,
    carried: [] });
  assert.ok(prompt.includes(section(CHANGES, [`- Child task ${child} "Silent child": state error`])), prompt);
});

test('returns carried to the request come in their own part; a handover is one of its lines, never a section of its own', async t => {
  const w = await workspace(t);
  const work = await w.create('Work', w.project);
  const carried: ReturnLine[] = [
    { id: 'X1', outcome: 'answer', taskId: work, questionId: 'L9', text: 'Use blue' },
    { id: 'X2', outcome: 'handover', taskId: work, state: 'doing' },
  ];
  const prompt = await launch(w, work, { carried });
  assert.ok(prompt.includes(`${CARRIED}\nReturns and notices that arrived (2):\n`), prompt);
  assert.ok(prompt.includes('Use blue'));
  assert.ok(prompt.includes(`- Task ${work}: handover: you are now its owner. Current state: doing. `));
  assert.equal(headings(prompt).some(heading => /handover/i.test(heading)), false);
  assert.equal(headings(await launch(w, work)).includes(CARRIED.slice(3)), false);
  // A worker carries nothing.
  assert.equal(headings(await launch(w, work, { carried, responsible: false })).includes(CARRIED.slice(3)), false);
});

test('a worker is told its Task boundaries and gets its Task\'s and its parent\'s context and reading commands', async t => {
  const w = await workspace(t);
  const parent = await w.create('Parent', w.project), work = await w.create('Work', parent);
  await w.write(parent, { policy: ['Try it first'] });
  await w.write(work, { goal: 'Working preview', notes: 'line of text\nand more' });
  const prompt = await launch(w, work, { responsible: false, body: 'Member work',
    condition: { agent: 'codex', values: {} }, voidsEstimate: true, carried: [] });
  assert.match(prompt.split('\n')[0]!,
    /You are a member of this task\. Do not change the task's values, state, questions or placements\. Put anything you need decided in your final reply, with your result and what you verified/);
  assert.deepEqual(headings(prompt), ['Task', 'Parent task', 'Request', 'Reading records']);
  assert.ok(prompt.includes(JSON.stringify({ id: work, title: 'Work', state: 'todo',
    context: '## Goal\nWorking preview\n\n## Notes\nline of text\nand more' })), prompt);
  assert.ok(prompt.includes(JSON.stringify({ id: parent, title: 'Parent', state: 'todo', context: '## Policy\n- Try it first' })));
  assert.ok(prompt.includes('\n## Request\nMember work\n'));
  // A continuation is the heading and the message.
  const continued = await launch(w, work, { responsible: false, mode: 'continue', since: new Date().toISOString(),
    body: 'Fix the result' });
  assert.deepEqual(headings(continued), ['Request']);
});

test('every launch, an owner\'s or a member\'s, new or continued, is told the user\'s saved language', async t => {
  const w = await workspace(t);
  const work = await w.create('Work', w.project), line = languageLine('fr-CA');
  assert.match(line, /^Language: fr-CA \(French\)\./);
  const continued = { mode: 'continue' as const, since: new Date().toISOString() };
  for (const responsible of [true, false]) {
    assert.ok((await launch(w, work, { replyLanguage: 'fr-CA', responsible })).includes(line));
    assert.ok((await launch(w, work, { replyLanguage: 'fr-CA', responsible, ...continued })).includes(line));
    assert.equal((await launch(w, work, { replyLanguage: null, responsible })).includes('Language:'), false);
  }
});

test('a request says who wrote it, so that the user\'s own words are told from an AI\'s', async t => {
  assert.deepEqual([requestAuthor('instruction', 'human', true), requestAuthor('instruction', 'main', true),
    requestAuthor('instruction', 'placement', true), requestAuthor('instruction', 'placement', false),
    requestAuthor('return_continuation', 'placement', true)], ['user', 'coordinator', 'above', 'owner', 'alpacawork']);
  const w = await workspace(t);
  const work = await w.create('Work', w.project);
  assert.ok((await launch(w, work, { author: 'coordinator' })).includes('\n## Request\nWritten by the coordinator.\nDo the work\n'));
});

test('the start text stays within PROTOCOL_LIMITS.prompt: the message goes whole, a part that does not fit becomes its command', async t => {
  const w = await workspace(t);
  const work = await w.create('Work', w.project);
  await w.write(work, { policy: Array.from({ length: 400 }, (_, at) => `${at} ${'x'.repeat(1000)}`) });
  const message = 'a'.repeat(MAX_INSTRUCTION_BYTES);
  const carried: ReturnLine[] = Array.from({ length: 300 }, (_, at) =>
    ({ id: `X${at}`, outcome: 'answer', taskId: work, questionId: `L${at}`, text: 'y'.repeat(2000) }));
  const prompt = await launch(w, work, { body: message, carried, condition: { agent: 'codex', values: {} } });
  assert.ok(Buffer.byteLength(prompt) <= PROTOCOL_LIMITS.prompt, `${Buffer.byteLength(prompt)}`);
  assert.ok(prompt.includes(`\n## Request\n${message}\n`));
  assert.ok(prompt.includes(`## Task\nToo large to include. Read it with alpacawork task get --task ${work}.`), prompt.slice(0, 2000));
  // What the carried returns could not hold is named with where it is read.
  assert.match(prompt, /\d+ more do not fit here\./);
});

test('the responsible sees the task get reference examples before deciding an estimate', async t => {
  const w = await workspace(t);
  const work = await w.create('Work', w.project);
  const input = { mode: 'new' as const, body: 'Decide the estimate',
    condition: { agent: 'codex', values: { model: 'opus', effort: 'high', speed: 'fast' } } };
  const prompt = await launch(w, work, input);
  const history = prompt.split('## Estimate examples (read before you estimate)\n')[1]!.split('\n')[1]!;
  assert.deepEqual(JSON.parse(history), { agent: 'codex', values: input.condition.values, examples: [], errors: [] });
  assert.match(prompt, /the same agent with all the same launch selections/);
  // The figures remain here; their definitions and the estimating procedure have one owner in the skill.
  assert.match(prompt, /For what the values mean and how to estimate, see the owner procedure in the alpacawork skill/);
  assert.ok(prompt.indexOf('## Estimate examples (read before you estimate)') < prompt.indexOf('## Request'));
  assert.doesNotMatch(await launch(w, work, { ...input, responsible: false }), /Estimate examples \(read before you estimate\)/);
});

test('a request that voids the estimate says so once, in new and continued (or joined) conversations alike', async t => {
  const w = await workspace(t);
  const work = await w.create('Work', w.project);
  const input = { body: 'More work', condition: { agent: 'codex', values: { model: 'opus' } } };
  for (const mode of ['new', 'continue'] as const) {
    const since = mode === 'new' ? null : new Date().toISOString();
    const prompt = await launch(w, work, { ...input, mode, since, voidsEstimate: true });
    const said = prompt.match(/^.*estimate.*void.*$/m)?.[0];
    assert.ok(said, mode);
    assert.match(said, /the owner procedure in the alpacawork skill/);
    assert.doesNotMatch(said, /task report --state doing --estimate-minutes/);
    assert.equal(prompt.split(said).length, 2, 'said once');
    assert.ok(prompt.indexOf(said) < prompt.indexOf('## Request'));
    // A wake by replies leaves the estimate standing, so it says nothing of it.
    assert.doesNotMatch(await launch(w, work, { ...input, mode, since, voidsEstimate: false }), /estimate.*void/);
  }
  assert.doesNotMatch(await launch(w, work, { ...input, responsible: false, voidsEstimate: true }), /estimate.*void/);
});

test('the owner receives its whole context as recorded at admission, in full once per version in a conversation', async t => {
  const w = await workspace(t), work = await w.create('Notes', w.project);
  const values = { conclusion: 'Original decision', notes: 'Keep the verified result.\n\nOld narrative stays with it.' };
  await w.write(work, values);
  let supplied: string | undefined;
  const text = await launch(w, work, { observedChildren: {}, body: 'Replace the old approach',
    onSnapshotSupplied: version => { supplied = version; } });
  const own = text.split('## Task\n')[1]!.split('\n\n## ')[0]!;
  assert.match(own, /The task record as of when this request was accepted/);
  assert.match(own, /before the request is applied/);
  assert.deepEqual(JSON.parse(own.split('\n').find(line => line.startsWith('{'))!),
    { id: work, title: 'Notes', context: contextOf(values) });
  assert.ok(text.includes('\n## Request\nReplace the old approach\n'));
  // The same version again in this conversation is named only; a changed one comes whole.
  const since = new Date().toISOString();
  const same = await launch(w, work, { mode: 'continue', since, heldSnapshot: supplied });
  assert.match(same, /## Task\nSame version as the record this conversation was already given in full/);
  assert.doesNotMatch(same, /Original decision/);
  await w.write(work, { ...values, conclusion: 'New decision' });
  assert.match(await launch(w, work, { mode: 'continue', since, heldSnapshot: supplied }), /New decision/);
});

/** The responsible placements of `taskIds`, by Task. */
const place = (root: string, taskIds: string[]) => new Map(taskIds.map(taskId => [taskId, responsibleOf(root, taskId)]));
const prompt = (root: string, runId: string) => {
  const runs = new RunStore(root, { busyTimeoutMs: 0 });
  try { return runs.getText(runId)!.prompt; } finally { runs.close(); }
};
const human = { purpose: 'instruction', actor: { kind: 'human' } } as const;

test('an admitted request\'s start text names the Task and its parent\'s context; its continuation says only what is new', async t => {
  const w = await workspace(t);
  const top = await w.create('Top', w.project), child = await w.create('Child', top);
  await w.write(top, { policy: ['Try it first'] });
  await w.write(child, { goal: 'Ship it.' });
  const placements = place(w.root, [top, child]);
  const service = new RequestService(w.root);
  const request = async (taskId: string, body: string, more: { mode?: 'new' | 'continue'; expectedHeadRunId?: string } = {}) =>
    service.request({ taskId, mode: 'new', body, requestId: randomUUID(), expectedTaskHash: (await w.tasks.get(taskId)).hash,
      expectedPlacementRevision: placements.get(taskId)!.revision, ...more }, human);
  // A top Task's parent is its project, whose lines the chain carries: no parent part. Child creation sends no notice.
  const first = prompt(w.root, (await request(top, 'Top work')).runId);
  assert.deepEqual(headings(first), ['Task', CHILDREN.slice(3), 'Open work', 'Estimate examples (read before you estimate)', 'Request',
    'Reading records', 'Writing records']);
  assert.ok(first.includes(section(CHILDREN, [`- Child task ${child} "Child": state todo`])), first);
  assert.ok(!first.includes('child added'), first);
  const opened = await request(child, 'Child work');
  const text = prompt(w.root, opened.runId);
  assert.match(text.split('\n')[0]!, /You are the owner of this task\. Read the alpacawork skill before/);
  assert.deepEqual(headings(text), ['Task', 'Parent task', 'Open work', 'Estimate examples (read before you estimate)', 'Request', 'Reading records', 'Writing records']);
  assert.ok(text.includes(JSON.stringify({ id: child, title: 'Child', context: '## Goal\nShip it.' })), text);
  assert.ok(text.includes(JSON.stringify({ id: top, title: 'Top', state: 'todo', context: '## Policy\n- Try it first' })));
  assert.ok(text.includes('\n## Request\nWritten by the user.\nChild work\n'));
  const next = await request(child, 'More child work', { mode: 'continue', expectedHeadRunId: opened.runId });
  const continued = prompt(w.root, next.runId);
  assert.match(continued.split('\n')[0]!, /continuing the same conversation.*You are the owner of this task/);
  // The first Run is still queued, so no receipt of its Task part is proved: that part comes again.
  assert.deepEqual(headings(continued), ['Task', 'Estimate examples (read before you estimate)', 'Request']);
});

test('explicit owner instructions to parent and child both void the estimate', async t => {
  const w = await workspace(t);
  const top = await w.create('Top', w.project), child = await w.create('Child', top);
  const placements = place(w.root, [top, child]);
  const service = new RequestService(w.root);
  const input = async (taskId: string) => ({ taskId, mode: 'new' as const, body: 'Work', requestId: randomUUID(),
    expectedTaskHash: (await w.tasks.get(taskId)).hash, expectedPlacementRevision: placements.get(taskId)!.revision });
  const owner = await service.request(await input(top), human);
  assert.match(prompt(w.root, owner.runId), /estimate.*void/);
  const plain = await service.request(await input(child), human);
  assert.match(prompt(w.root, plain.runId), /estimate.*void/);
});

test('request text over 160 KiB is refused before any Request, Run or prompt; 160 KiB is accepted', async t => {
  const w = await workspace(t);
  const work = await w.create('Work', w.project);
  const placement = place(w.root, [work]).get(work)!;
  const service = new RequestService(w.root);
  const input = async (bytes: number) => ({ taskId: work, mode: 'new' as const, body: 'a'.repeat(bytes), requestId: randomUUID(),
    expectedTaskHash: (await w.tasks.get(work)).hash, expectedPlacementRevision: placement.revision });
  await assert.rejects(service.request(await input(MAX_INSTRUCTION_BYTES + 1), human), (error: {
    code?: string;
  }) => error.code === 'too_large');
  const store = new RunStore(w.root, { busyTimeoutMs: 0 });
  try {
    assert.deepEqual([store.readRequests().length, store.read().length], [0, 0]);
  } finally {
    store.close();
  }
  const accepted = await service.request(await input(MAX_INSTRUCTION_BYTES), human);
  assert.ok(Buffer.byteLength(prompt(w.root, accepted.runId)) <= PROTOCOL_LIMITS.prompt);
});

test('a child section replaced by a command certifies no child versions', async t => {
  const w = await workspace(t), parent = await w.create('Parent', w.project), child = await w.create('Large child', parent);
  await w.write(child, { conclusion: 'a'.repeat(PROTOCOL_LIMITS.prompt) });
  const observedChildren: Record<string, string> = {};
  const prompt = await launch(w, parent, { observedChildren, childVersions: {} });
  assert.ok(Buffer.byteLength(prompt) <= PROTOCOL_LIMITS.prompt);
  assert.match(prompt, /Too large to include/);
  assert.deepEqual(observedChildren, {}, 'fetching a list is not receipt or incorporation of child details');
});


test('top Task user instructions reach its owner, descendants and members without substituting child words', async t => {
  const w = await workspace(t);
  const top = await w.create('Top', w.project), child = await w.create('Child', top), grand = await w.create('Grand', child);
  await w.write(top, { user_instructions: ['11/4 「元の依頼と担当分を渡す」'] });
  await w.write(child, { user_instructions: ['Child interpretation'] });
  const heading = '## User instructions (background; your scope is the part the request gives you)\n';
  for (const task of [child, grand]) for (const responsible of [true, false]) {
    const prompt = await launch(w, task, { responsible });
    assert.equal(prompt.split(heading)[1]?.split('\n')[0], JSON.stringify({ task: top, lines: ['11/4 「元の依頼と担当分を渡す」'] }));
  }
  // The top Task's own launch carries them in its context, not twice.
  for (const responsible of [true, false]) {
    const prompt = await launch(w, top, { responsible });
    assert.equal(prompt.includes(heading), false);
    assert.equal(prompt.split('11/4 「元の依頼と担当分を渡す」').length, 2);
  }
});

test('continuations repeat user instructions after updates, and omit them when unchanged or absent', async t => {
  const w = await workspace(t);
  const top = await w.create('Top', w.project), child = await w.create('Child', top), grand = await w.create('Grand', child);
  for (const responsible of [true, false]) assert.doesNotMatch(await launch(w, grand, { responsible }), /## User instructions/);
  await w.write(top, { user_instructions: ['11/4 「初めの依頼」'] });
  await delay(5);
  const since = new Date().toISOString();
  await delay(5);
  for (const responsible of [true, false]) assert.doesNotMatch(await launch(w, grand, { responsible, mode: 'continue', since }), /## User instructions/);
  await w.write(top, { user_instructions: ['11/4 「更新した決定」'] });
  for (const responsible of [true, false]) {
    const prompt = await launch(w, grand, { responsible, mode: 'continue', since });
    assert.match(prompt, /更新した決定/);
    assert.doesNotMatch(prompt, /初めの依頼/);
  }
  await w.write(top, { goal: 'No words' });
  for (const responsible of [true, false]) assert.doesNotMatch(await launch(w, grand, { responsible, mode: 'continue', since }), /## User instructions/);
});

test('oversize user instructions become their top Task read command within the prompt budget for new and continued members and owners', async t => {
  const w = await workspace(t);
  const top = await w.create('Top', w.project), child = await w.create('Child', top);
  await w.write(top, { user_instructions: ['11/4 「' + 'あ'.repeat(100_000) + '」'] });
  for (const responsible of [true, false]) for (const mode of ['new', 'continue'] as const) {
    const prompt = await launch(w, child, { responsible, mode, since: '2000-01-01T00:00:00Z', body: 'x'.repeat(MAX_INSTRUCTION_BYTES) });
    assert.ok(Buffer.byteLength(prompt) <= PROTOCOL_LIMITS.prompt);
    assert.ok(prompt.includes(`Read "User instructions" with alpacawork task get --task ${top}.`));
    assert.doesNotMatch(prompt, /ああ/);
  }
});

test('top owner values saved with a report or question invalidate user instructions for continued descendants', async t => {
  const w = await workspace(t);
  const top = await w.create('Top', w.project), child = await w.create('Child', top);
  const since = new Date().toISOString();
  const source = await w.source(), task = source.tree.byId.get(top)!;
  // Owner reports and questions save the values with a checkpoint, rather than a body_updated event.
  // Use their stored admission-time representation; the report service's checkpoints have separate integration tests.
  const facts = readControl(w.root, db => readContextFacts(db, source.tree));
  source.contexts = taskContexts(source.tree, { ...facts,
    values: new Map(facts.values).set(top, { user_instructions: ['11/4 「報告と同時に直した決定」'] }) });
  for (const kind of ['reported', 'asked'] as const) {
    task.meta.log.push({ id: 'Lbody-' + kind, kind, at: new Date(Date.now() + 100).toISOString(),
      title: 'Owner saved body', description: null, actor: { kind: 'human' }, fromState: null, toState: null,
      checkpoint: { bodyHash: 'a'.repeat(64), inputHead: 'R1', children: {} } });
    for (const responsible of [true, false]) {
      const prompt = await launch(w, child, { source, responsible, mode: 'continue', since });
      assert.match(prompt, /報告と同時に直した決定/);
    }
    task.meta.log.pop();
  }
});
