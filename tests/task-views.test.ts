import { DEFAULT_SCHEMA } from '@alpacawork/contract';
import { decideValues, seedValues } from './helpers/task-values.ts';
import { fixtureAgentSetting } from './helpers/agent-stub.ts';
import { stringify } from 'yaml';
import { DatabaseSync } from 'node:sqlite';
import { controlDatabasePath } from '@alpacawork/db';
import { currentTaskLog } from './helpers/control-fixture.ts';
import { taskBodyRead } from './helpers/task-body-read.ts';
import { commandFetch as fetch } from './helpers/command-fetch.ts';
import { createFixtureRun } from './helpers/run-fixture.ts';
import { initializeControlFixture } from './helpers/control-fixture.ts';
import { reconcileLinks } from './return-handling.fixture.ts';
/** The read commands return only what was asked for, with remote file URLs and whole lines. */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TaskActor } from '@alpacawork/raw';
import { FileWriter } from '@alpacawork/backend/test-dist/raw/storage.js';
import { ControlTaskCommands } from '@alpacawork/backend/test-dist/control/task-commands.js';
import { ControlTaskStore } from '@alpacawork/backend/test-dist/control/task-store.js';
import { TaskReportService } from '@alpacawork/backend/test-dist/control/report.js';
import { RequestService } from '@alpacawork/backend/test-dist/control/requests.js';
import type { Caller } from '@alpacawork/backend/test-dist/control/authorize.js';
import { readControlSource, readTaskView, readTaskListView, taskListView, taskView } from '@alpacawork/backend/test-dist/control/task-views.js';
import { RunStore } from '@alpacawork/runs';
import { PlacementStore } from '@alpacawork/backend/test-dist/control/placements.js';
import { fields } from './runs-fixtures.ts';
import { startServer } from '@alpacawork/backend/test-dist/receiver/server.js';
import { cliRun } from './helpers/http-cli.ts';
import { cliCommand } from './helpers/cli-session.ts';

/** A launch profile that never runs anything: no Run here is left queued for serve to start. */
const AGENTS = stringify({ agents: { "codex": fixtureAgentSetting('codex') } });
const servers = new Map<string, Promise<Awaited<ReturnType<typeof startServer>>>>();
/** The workspace's server, started by the first command, after the records a test prepares are written. */
async function url(root: string): Promise<string> {
    let pending = servers.get(root);
    if (!pending) {
        pending = startServer(root, 0);
        servers.set(root, pending);
    }
    return (await pending).url;
}
async function cli(root: string, args: string[]) {
    const result = await cliCommand(await url(root), args);
    return { code: result.code, stdout: result.stdout, stderr: result.stderr,
        json: result.stdout ? JSON.parse(result.stdout) : null,
        error: result.stderr.trimStart().startsWith('{') ? JSON.parse(result.stderr) : null };
}
/** The Task's responsible placement, placed now (as a store write, which leaves the Task's hash) when it has none. */
function responsibleOf(root: string, taskId: string) {
    const people = new PlacementStore(root);
    try {
        return people.placements(taskId).find(placement => placement.responsible && placement.active)
            ?? people.createAndPlace({ taskId, profileKey: 'codex', responsible: true }).placement;
    }
    finally {
        people.close();
    }
}
/**
 * The root project P1, the test project below it (`project`), and Top, the user's, under that with Child and Sibling,
 * and Grandchild under Child, the agents' own (so no notice wakes a seat). A Task with children keeps its responsible,
 * so Top and Child have one before their children are made.
 */
async function setup(t: TestContext) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'alpacawork-views-')));
    const writer = new FileWriter(root);
    let project: string;
    try {
        writer.save('config.yaml', null, Buffer.from(AGENTS));
        project = initializeControlFixture(root);
    }
    finally {
        writer.close();
    }
    t.after(async () => { await (await servers.get(root))?.close(); servers.delete(root); rmSync(root, { recursive: true, force: true }); });
    const commands = new ControlTaskCommands(root, { kind: 'human' });
    const create = async (title: string, parentId: string) =>
        (await commands.create({ parentId, userRequested: parentId === project ? null : false, tasks: [{ title }] })).tasks[0];
    const top = await create('Top', project);
    responsibleOf(root, top.id);
    const child = await create('Child', top.id);
    const sibling = await create('Sibling', top.id);
    responsibleOf(root, child.id);
    const grandchild = await create('Grandchild', child.id);
    return { root, project, commands, top, child, sibling, grandchild };
}
type Setup = Awaited<ReturnType<typeof setup>>;
/**
 * Reports on Task `taskId` as its responsible Run does: a person's request starts the Run, `report` writes as the Run
 * with the Task's current hash, and the Run ends; its start and end are applied as a pass applies them. No process runs.
 */
async function asResponsible(h: Setup, taskId: string,
    report: (actor: TaskActor, caller: Caller, expectedTaskHash: string) => Promise<unknown>) {
    const tasks = new ControlTaskStore(h.root);
    const placement = responsibleOf(h.root, taskId);
    const { runId } = await new RequestService(h.root).request({ taskId, mode: 'new', body: 'Work on it', requestId: randomUUID(),
        expectedTaskHash: (await tasks.get(taskId)).hash, expectedPlacementRevision: placement.revision },
    { purpose: 'instruction', actor: { kind: 'human' } });
    const store = new RunStore(h.root, { busyTimeoutMs: 0 });
    try {
        store.write(tx => tx.update({ ...tx.get(runId)!, state: 'running', started_at: new Date().toISOString() }));
        await report({ kind: 'placement', placementId: placement.id },
            { kind: 'run', runId, placementId: placement.id, taskId, role: 'owner', responsible: true }, (await tasks.get(taskId)).hash);
        store.write(tx => tx.finish({ ...tx.get(runId)!, state: 'succeeded', ended_at: new Date().toISOString() },
            { state: 'present', text: 'reply' }));
    }
    finally {
        store.close();
    }
    reconcileLinks(h.root, h.project);
}
/** An internal Task done by its responsible's report. */
const finish = (h: Setup, taskId: string) => asResponsible(h, taskId, (actor, caller, expectedTaskHash) =>
    new TaskReportService(h.root).report({ task: taskId, state: 'done', title: 'Done', description: 'The result is ready for review.', opId: randomUUID(), expectedTaskHash },
        actor, caller));
/** The question `title` the Task's responsible Run asks of its decide value; its ID. */
async function ask(h: Setup, taskId: string, title: string, description: string): Promise<string> {
    const opId = randomUUID();
    await asResponsible(h, taskId, (actor, caller, expectedTaskHash) => new TaskReportService(h.root).report({ task: taskId,
        state: 'waiting', askTo: 'user', title, description, opId, expectedTaskHash }, actor, caller));
    return opId;
}

test('task get returns the Task with its kind, project, mark, questions and review Run, and more only when asked', async (t) => {
    const h = await setup(t);
    const plain = (await cli(h.root, ['task', 'get', '--task', h.child.id]));
    assert.equal(plain.code, 0);
    assert.deepEqual(Object.keys(plain.json).sort(), ['agents', 'decisionsMade', 'dependencies', 'errors', 'incomingQuestions',
        'questions', 'relevantAnswers', 'requestedByUser', 'reviewRun', 'shelf', 'task']);
    assert.deepEqual(plain.json.shelf, { listed: true, shelvedBy: [], restoreTarget: null });
    assert.deepEqual(plain.json.dependencies, { after: [], started: false, waiting: false });
    assert.deepEqual(Object.keys(plain.json.task).sort(), ['baseState', 'folder', 'hash', 'hold', 'id', 'kind', 'lifecycle',
        'parentId', 'projectId', 'state', 'title', 'userRequested']);
    assert.equal(plain.json.task.values, undefined);
    const fields = await cli(h.root, ['task', 'get', '--task', h.child.id, '--include', 'fields']);
    assert.deepEqual(fields.json.task.fields, { fields: [...DEFAULT_SCHEMA], from: null });
    assert.deepEqual([plain.json.task.baseState, plain.json.task.hold], ['todo', false]);
    // The agents' own Task: no question, nothing under review, and not the user's.
    assert.deepEqual([plain.json.task.kind, plain.json.task.projectId, plain.json.task.userRequested], ['task', h.project, false]);
    assert.deepEqual([plain.json.questions, plain.json.reviewRun, plain.json.requestedByUser], [[], null, null]);
    assert.ok(!('openObligations' in plain.json), 'full open work is an explicit read, not default context');
    const open = await cli(h.root, ['task', 'get', '--task', h.child.id, '--include', 'openObligations']);
    assert.equal(open.code, 0, open.stderr);
    assert.deepEqual(open.json.openObligations, { requests: [], returns: [] });
    assert.deepEqual(open.json.errors, []);
    // A person's Task is the user's, asked for when it was created.
    const top = (await cli(h.root, ['task', 'get', '--task', h.top.id])).json;
    assert.deepEqual([top.task.userRequested, top.requestedByUser], [true, { at: currentTaskLog(h.root, h.top.id)[0]!.at }]);
    const project = (await cli(h.root, ['task', 'get', '--task', h.project])).json;
    assert.deepEqual([project.task.kind, project.task.projectId, project.task.parentId, project.task.userRequested,
        project.requestedByUser], ['project', h.project, 'P1', false, null]);
    assert.equal(plain.json.task.folder, new URL(`/api/tasks/${h.child.id}/file?path=`, await url(h.root)).href);
    const folder = join(h.root, 'tasks', h.child.id);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'note.txt'), 'artifact');
    const more = (await cli(h.root, ['task', 'get', '--task', h.child.id, '--log', '1', '--runs', '2', '--include', 'files']));
    assert.equal(more.json.task.log.length, 1);
    assert.equal(more.json.task.log[0].kind, 'created');
    assert.deepEqual(more.json.runs, []);
    assert.deepEqual(more.json.task.files.map((file: {
        path: string;
    }) => file.path), [new URL(`/api/tasks/${h.child.id}/file?path=note.txt`, await url(h.root)).href]);
    assert.equal(await (await fetch(more.json.task.files[0].path)).text(), 'artifact');
    // 0 asks for none of them; it must not fall back to all of them.
    const saved = await h.commands.update({ id: h.child.id, values: { notes: 'more log' }, expectedTaskHash: h.child.hash });
    assert.equal((await cli(h.root, ['task', 'get', '--task', h.child.id, '--log', '100'])).json.task.log.length, 2);
    const none = (await cli(h.root, ['task', 'get', '--task', h.child.id, '--log', '0', '--runs', '0'])).json;
    assert.deepEqual([none.task.log, none.runs], [[], []]);
    assert.deepEqual((await cli(h.root, ['task', 'get', '--task', h.child.id, '--log', '1'])).json.task.log.map((entry: {
        kind: string;
    }) => entry.kind), ['body_updated']);
    await new TaskReportService(h.root).report({ task: h.child.id, state: 'held', opId: randomUUID(),
        expectedTaskHash: none.task.hash }, { kind: 'human' }, { kind: 'human' });
    // With no history requested, the CLI still gives an agent the held Task's actual current base.
    const held = (await cli(h.root, ['task', 'get', '--task', h.child.id, '--log', '0'])).json;
    assert.deepEqual([held.task.state, held.task.baseState, held.task.hold, held.task.log], ['held', 'todo', true, []]);
});
test('task get lists open questions and --question gives one\'s full text as fixed when asked; another Task\'s is not found', async (t) => {
    const h = await setup(t);
    const values = { conclusion: 'Waiting for a selection', notes: 'Choose a color.', decide: [{ decide_question: 'Color',
        decide_choices: [{ decide_choice: 'Red', decide_choice_detail: 'Stands out', decide_choice_recommended: 'Reads at a glance' },
            { decide_choice: 'Blue', decide_choice_detail: 'Calm' }, { decide_choice: 'Green' }],
        decide_note: 'All pass contrast', decide_stop: 'The button stays grey' }, { decide_question: 'Label' }] };
    await h.commands.update({ id: h.top.id, values, expectedTaskHash: h.top.hash });
    const questionId = await ask(h, h.top.id, 'Which colour', 'Pick the colour of the button');
    // The text an agent reads: the note as written, the recommendation and what stopping means led by what they are.
    const text = ['### 1 Color', '#### Red', 'Stands out', 'Recommended: Reads at a glance', '#### Blue', 'Calm', '#### Green', '',
        'All pass contrast', '', 'Stop: The button stays grey', '', '### 2 Label'].join('\n');
    const asked = (await cli(h.root, ['task', 'get', '--task', h.top.id])).json;
    // Top's requester is the user: the question asks the user, in short; its full text comes only when asked for.
    assert.deepEqual(asked.questions.map((question: { id: string; destination: {kind:string}; title: string; summary: string }) =>
        [question.id, question.destination.kind, question.title, question.summary]), [[questionId, 'user', 'Which colour', 'Pick the colour of the button']]);
    assert.equal('question' in asked, false);
    assert.deepEqual(['text', 'decide'].filter(key => key in asked.questions[0]), []);
    const first = (await cli(h.root, ['task', 'get', '--task', h.top.id, '--question', questionId])).json.question;
    assert.deepEqual([first.id, first.state, first.text, 'answer' in first], [questionId, 'open', text, false]);
    // Rewriting the values leaves the question as it was asked.
    await h.commands.update({ id: h.top.id, values: { conclusion: 'Rewritten', decide: null }, expectedTaskHash: asked.task.hash });
    assert.deepEqual((await cli(h.root, ['task', 'get', '--task', h.top.id, '--question', questionId])).json.question, first);
    const other = await cli(h.root, ['task', 'get', '--task', h.child.id, '--question', questionId]);
    assert.equal(other.code, 2);
    assert.equal(other.error.error.code, 'not_found');
    assert.equal((await fetch(new URL(`/api/commands/task/get?task=${h.child.id}&question=${questionId}`, await url(h.root)))).status, 404);
});
test('task get --usage adds own and all descendant Run totals only on request', async (t) => {
    const h = await setup(t);
    const counters = (input: number) => ({ input, cacheRead: 0, cacheWrite: 0, output: 1 });
    const placements = new Map([h.child.id, h.grandchild.id].map(taskId => [taskId, responsibleOf(h.root, taskId).id]));
    const store = new RunStore(h.root, { busyTimeoutMs: 3000 });
    try {
        for (const [task, input] of [[h.child.id, 10], [h.grandchild.id, 20]] as const)
            store.write(tx => {
                const queued = createFixtureRun(store, tx, fields({ task, cwd: h.root, placementId: placements.get(task)! }), 'fixture prompt');
                const started = { ...queued, state: 'running' as const, started_at: '2026-10-05T12:00:00Z' };
                tx.update(started);
                tx.finish({ ...started, state: 'succeeded', ended_at: '2026-10-05T12:01:00Z',
                    exit: { code: 0, signal: null }, usage: { conversation: counters(input), run: counters(input), includesEarlier: false } }, { state: 'present', text: 'fixture reply' });
            });
    }
    finally {
        store.close();
    }
    const ordinary = (await cli(h.root, ['task', 'get', '--task', h.child.id]));
    assert.equal(ordinary.code, 0, JSON.stringify(ordinary.error));
    assert.equal('usage' in ordinary.json, false);
    const result = (await cli(h.root, ['task', 'get', '--task', h.child.id, '--include', 'usage']));
    assert.equal(result.code, 0, JSON.stringify(result.error));
    assert.deepEqual([result.json.usage.own.tokens.input, result.json.usage.subtree.tokens.input], [10, 30]);
    assert.deepEqual([result.json.usage.own.runMs, result.json.usage.subtree.runMs], [60000, 120000]);
});
test('task list keeps the project path to each row, with depth, all and text', async (t) => {
    const h = await setup(t);
    const projects = ['P1', h.project];
    await h.commands.lifecycle({ id: h.sibling.id, action: 'archive', expectedTaskHash: h.sibling.hash });
    const ids = async (args: string[]) => (await cli(h.root, ['task', 'list', ...args])).json.tasks.map((task: {
        id: string;
    }) => task.id);
    const whole = (await cli(h.root, ['task', 'list'])).json;
    assert.deepEqual(Object.keys(whole), ['tasks', 'errors']);
    assert.deepEqual(Object.keys(whole.tasks[0]), ['id', 'kind', 'parentId', 'lifecycle', 'title', 'state']);
    assert.deepEqual(whole.tasks.map((task: { kind: string }) => task.kind), ['project', 'project', 'task', 'task', 'task']);
    assert.deepEqual((await ids([])), [...projects, h.top.id, h.child.id, h.grandchild.id]);
    assert.deepEqual((await ids(['--all'])), [...projects, h.top.id, h.child.id, h.sibling.id, h.grandchild.id]);
    assert.deepEqual((await ids(['--under', h.child.id])), [h.child.id, h.grandchild.id]);
    assert.deepEqual((await ids(['--under', h.top.id, '--depth', '1', '--all'])), [h.top.id, h.child.id, h.sibling.id]);
    // The root project is at depth 1, the test project at 2, Top at 3.
    assert.deepEqual((await ids(['--depth', '1'])), ['P1']);
    assert.deepEqual((await ids(['--depth', '3'])), [...projects, h.top.id]);
    assert.deepEqual((await ids(['--under', h.top.id, '--depth', '0'])), [h.top.id]);
    assert.deepEqual((await ids(['--text', 'grand'])), [...projects, h.top.id, h.child.id, h.grandchild.id]);
    assert.equal((await cli(h.root, ['task', 'list', '--under', 'T999'])).code, 2);
});
test('task list omits done by default, preserves ancestors and selects states explicitly', async (t) => {
    // The agents' own Tasks finish as done when their Run reports it; the user's would wait for review.
    const h = await setup(t);
    const projects = ['P1', h.project];
    await finish(h, h.sibling.id);
    await finish(h, h.grandchild.id);
    const result = async (args: string[]) => (await cli(h.root, ['task', 'list', ...args]));
    const ids = async (args: string[]) => (await result(args)).json.tasks.map((task: {
        id: string;
    }) => task.id);
    assert.deepEqual(Object.keys((await result([])).json), ['tasks', 'errors']);
    assert.deepEqual((await ids([])), [...projects, h.top.id, h.child.id]);
    assert.deepEqual((await ids(['--under', h.top.id, '--depth', '1'])), [h.top.id, h.child.id]);
    assert.deepEqual((await ids(['--under', h.child.id, '--depth', '0'])), [h.child.id]);
    assert.deepEqual((await ids(['--under', h.sibling.id])), []);
    const all = [...projects, h.top.id, h.child.id, h.sibling.id, h.grandchild.id];
    assert.deepEqual((await ids(['--state', 'done'])), all);
    // A project has no working state of its own: it stays todo.
    assert.deepEqual((await ids(['--state', 'todo'])), [...projects, h.top.id, h.child.id]);
    assert.deepEqual((await ids(['--state', 'doing'])), []);
    assert.deepEqual((await ids(['--state', 'waiting'])), []);
    assert.deepEqual((await ids(['--state', 'done', '--state', 'todo'])), all);
    assert.deepEqual((await ids(['--state', 'all'])), all);
    assert.deepEqual((await ids(['--text', 'Sibling'])), [...projects, h.top.id, h.sibling.id]);
    assert.deepEqual((await ids(['--text', 'Sibling', '--state', 'doing'])), []);
    assert.deepEqual((await ids(['--under', h.child.id, '--text', 'grand'])), [h.child.id, h.grandchild.id]);
    assert.deepEqual((await ids(['--under', h.child.id, '--depth', '0', '--text', 'grand'])), []);
    assert.equal((await result(['--state', 'unknown'])).code, 2);
    const saved = (await cli(h.root, ['task', 'get', '--task', h.sibling.id])).json.task;
    await h.commands.lifecycle({ id: h.sibling.id, action: 'archive', expectedTaskHash: saved.hash });
    assert.deepEqual((await ids(['--state', 'done'])), [...projects, h.top.id, h.child.id, h.grandchild.id]);
    assert.deepEqual((await ids(['--all', '--state', 'done'])), all);
});
test('the --under Task comes first, then the rest in ID order', async (t) => {
    const h = await setup(t);
    const later = (await h.commands.create({ parentId: h.project, userRequested: null, tasks: [{ title: 'Later' }] })).tasks[0];
    // A task that gets a child keeps its responsible.
    responsibleOf(h.root, later.id);
    const moved = await h.commands.move({ id: h.top.id, parentId: later.id, expectedTaskHash: h.top.hash });
    assert.ok(moved);
    const ids = (await cli(h.root, ['task', 'list', '--under', later.id, '--depth', '1'])).json.tasks.map((task: {
        id: string;
    }) => task.id);
    assert.deepEqual(ids, [later.id, h.top.id]);
    const at = async (under: string, depth: number) => (await cli(h.root, ['task', 'list', '--under', under, '--depth', String(depth)])).json.tasks.map((task: {
        id: string;
    }) => task.id);
    assert.deepEqual((await at(later.id, 2)), [later.id, h.top.id, h.child.id, h.sibling.id]);
    assert.deepEqual((await at(h.child.id, 1)), [h.child.id, h.grandchild.id]);
    assert.deepEqual((await at(h.child.id, 0)), [h.child.id]);
});
test('relative file paths are refused and nothing is written in the root', async (t) => {
    const h = await setup(t);
    const before = readdirSync(h.root).sort();
    writeFileSync(join(h.root, 'relative.md'), '{}');
    const refused = await Promise.all([
        ['task', 'update', '--task', h.child.id, '--values-file', 'relative.md', '--expected-task-hash', h.child.hash,
            '--op-id', globalThis.crypto.randomUUID()],
        ['task', 'report', '--task', h.child.id, '--state', 'doing', '--title', 'Snapshot', '--values-file', 'relative.md',
            '--expected-task-hash', h.child.hash, '--op-id', globalThis.crypto.randomUUID()],
        ['task', 'request', '--task', h.child.id, '--instruction-file', 'relative.md', '--op-id', 'x',
            '--expected-task-hash', h.child.hash, '--expected-placement-revision', '1'],
    ].map(async (args) => (await cli(h.root, args))));
    for (const result of refused) {
        assert.equal(result.code, 2);
        assert.equal(result.error.error.code, 'invalid_input');
        assert.match(result.error.error.message, /absolute/);
    }
    assert.equal((await cli(h.root, ['task', 'get', '--task', h.child.id])).json.task.hash, h.child.hash);
    assert.deepEqual(readdirSync(h.root).filter(name => name !== 'relative.md').sort(), before);
    // The old names are gone, not aliases.
    const oldDelivery = (await cli(h.root, ['delivery', 'get', '--request-id', 'D' + '0'.repeat(64)]));
    assert.equal(oldDelivery.code, 2);
    assert.match(oldDelivery.stderr, /^error:/);
});
test('--log and --runs return the latest n, and 0 returns none even when there are some', async (t) => {
    const h = await setup(t);
    let hash = h.child.hash;
    for (const notes of ['first', 'second'])
        hash = (await h.commands.update({ id: h.child.id, values: { notes }, expectedTaskHash: hash })).task.hash;
    const placementId = responsibleOf(h.root, h.child.id).id;
    const store = new RunStore(h.root, { busyTimeoutMs: 3000 });
    try {
        // Ten Runs, so the latest are R9 and R10: in Run order, not in the order of their IDs' text.
        for (let n = 0; n < 10; n++)
            store.write(tx => {
                const started = { ...createFixtureRun(store, tx, fields({ task: h.child.id, cwd: h.root, placementId }), 'fixture'),
                    state: 'running' as const, started_at: '2026-10-03T00:00:00Z' };
                tx.update(started);
                tx.finish({ ...started, state: 'succeeded', ended_at: '2026-10-03T00:01:00Z', exit: { code: 0, signal: null } },
                    { state: 'present', text: 'reply' });
            });
    }
    finally {
        store.close();
    }
    const full = await readControlSource(h.root);
    const source = { ...full, runs: [...full.runs].reverse() };
    const log = full.tasks.find(task => task.id === h.child.id)!.log.map(entry => entry.id);
    assert.equal(log.length, 3);
    const at = (n: number) => taskView(source, h.child.id, { log: n, runs: n });
    assert.deepEqual([at(0).task.log, at(0).runs], [[], []]);
    assert.deepEqual([at(2).task.log?.map(entry => entry.id), at(2).runs?.map(run => run.id)], [log.slice(1), ['R9', 'R10']]);
    assert.deepEqual([at(20).task.log?.length, at(20).runs?.length], [3, 10]);
});

test('formal CLI reads only needed Task text and keeps full search and snapshot results', async t => {
    const h = await setup(t);
    const notes = new Map([[h.top, 'parent body\n'.repeat(40)], [h.child, 'child 😀\n'.repeat(40)],
        [h.sibling, 'sibling body\n'.repeat(40)], [h.grandchild, 'grandchild search\n'.repeat(40)]]);
    for (const [task, text] of notes) await h.commands.update({ id: task.id, values: { notes: text }, expectedTaskHash: task.hash });
    // What SQLite returns of a Task's values: their JSON text.
    const valueBytes = async (id: string) => Buffer.byteLength(JSON.stringify((await new ControlTaskStore(h.root).get(id)).values));
    const childBytes = await valueBytes(h.child.id);
    const summary = { project_summary: 'Work tracked by this project' };
    await h.commands.update({ id: h.project, values: { ...summary, project_policy: 'Track work here.\n'.repeat(20) },
        expectedTaskHash: (await new ControlTaskStore(h.root).get(h.project)).hash });
    // The root project has no values.
    const listBytes = Buffer.byteLength(JSON.stringify(summary.project_summary));
    let allBytes = Buffer.byteLength('{}') + await valueBytes(h.project);
    for (const task of notes.keys()) allBytes += await valueBytes(task.id);
    const full = await readControlSource(h.root);
    for (const options of [{}, { log: 2, runs: 1 }, { usage: true },
        { files: true }, { estimateExamples: true }, { openObligations: true }])
        assert.deepEqual(await readTaskView(h.root, h.child.id, options, null), {
            ...taskView(full, h.child.id, options), dependencies: { after: [], started: false, waiting: false },
        });
    for (const options of [{}, { under: h.child.id, depth: 1 }, { text: 'search' }, { text: '' },
        { depth: 1 }, { all: true, state: ['all'] as const }, { kind: 'project' as const }])
        assert.deepEqual(await readTaskListView(h.root, options, null), taskListView(full, options));
    // A person reads the whole workspace: the two projects and the four Tasks. The bytes are counted on the thread that reads.
    for (const [options, view] of [[[], {}], [['--log', '0', '--runs', '0'], { log: 0, runs: 0 }],
        [['--include', 'usage'], { usage: true }], [['--include', 'files'], { files: true }], [['--include', 'estimateExamples'], { estimateExamples: true }],
        [['--include', 'openObligations'], { openObligations: true }]] as const) {
        const result = await cli(h.root, ['task', 'get', '--task', h.child.id, ...options]);
        assert.equal(result.code, 0, result.stderr);
        assert.equal(result.json.task.values.notes, notes.get(h.child)!.trim());
        const { reads } = await taskBodyRead(() => readTaskView(h.root, h.child.id, view, null));
        assert.equal(reads.rows, 6, 'identity/relationship scope is still the complete workspace');
        assert.equal(reads.bytes, childBytes);
    }
    for (const [options, view] of [[[], {}], [['--under', h.child.id, '--depth', '0'], { under: h.child.id, depth: 0 }], [['--state', 'all', '--all'], { state: ['all'] as const, all: true }]] as const) {
        const result = await cli(h.root, ['task', 'list', ...options]);
        assert.equal(result.code, 0, result.stderr);
        const { reads } = await taskBodyRead(() => readTaskListView(h.root, view, null));
        assert.equal(reads.rows, 6);
        assert.equal(reads.bytes, listBytes, 'a list without text search reads only project summaries');
    }
    const search = await taskBodyRead(() => readTaskListView(h.root, { text: 'search' }, null));
    assert.equal(search.reads.bytes, allBytes);
    assert.deepEqual((search.result as { tasks: { id: string }[] }).tasks.map(task => task.id), ['P1', h.project, h.top.id, h.child.id, h.grandchild.id]);
    assert.equal((await cli(h.root, ['task', 'get', '--task', 'T999'])).code, 2);
});

test('task get retains project Run diagnostics while metadata lists avoid unrelated execution data', async t => {
    const h = await setup(t);
    const ids = [h.child.id, h.sibling.id].map(taskId => responsibleOf(h.root, taskId).id);
    const runs = new RunStore(h.root, { busyTimeoutMs: 1000 });
    const records = runs.write(tx => [h.child.id, h.sibling.id].map((task, i) => {
        const queued = createFixtureRun(runs, tx, fields({ task, placementId: ids[i]!, agent: 'codex', cwd: h.root }), 'fixture');
        const started = { ...queued, state: 'running' as const, started_at: '2026-10-01T00:00:00Z' };
        tx.update(started);
        const ended = { ...started, state: 'succeeded' as const, ended_at: '2026-10-01T00:01:00Z', exit: { code: 0, signal: null } };
        tx.finish(ended, { state: 'present', text: 'reply' });
        return ended;
    }));
    runs.close();
    const db = new DatabaseSync(controlDatabasePath(h.root));
    t.after(() => db.close());
    const read = () => readTaskView(h.root, h.child.id, { openObligations: true }, null);
    assert.deepEqual((await read()).errors, []);
    assert.equal((await cli(h.root, ['task', 'get', '--task', h.child.id])).code, 0, 'read once before the sibling\'s corruption');
    db.prepare("UPDATE runs SET record=json_set(record,'$.agent','Invalid Agent') WHERE id=?").run(Number(records[1]!.id.slice(1)));
    const get = await cli(h.root, ['task', 'get', '--task', h.child.id, '--runs', '3', '--include', 'usage', '--include', 'estimateExamples', '--include', 'openObligations']);
    assert.equal(get.code, 4, get.stderr);
    assert.equal(get.json.errors[0].code, 'runs_unavailable');
    assert.equal(get.json.agents[0].runtime.displayState, 'unknown');
    assert.deepEqual(get.json.runs, []);
    assert.equal(get.json.openObligations, null, 'an unreadable project is unknown, never an empty successful list');
    const degraded = await read();
    assert.equal(degraded.openObligations, null);
    assert.equal(degraded.agents[0]!.runtime.displayState, 'unknown');
    assert.ok(degraded.errors.some(error => error.code === 'runs_unavailable'));
    assert.equal(get.json.estimateExamples, null, "no reference Run remains when the project Run read is unavailable");
    const list = await cli(h.root, ['task', 'list', '--under', h.child.id, '--depth', '0']);
    assert.equal(list.code, 0);
    assert.deepEqual(list.json.errors, []);
    db.prepare('UPDATE runs SET record=? WHERE id=?').run(JSON.stringify(records[1]), Number(records[1]!.id.slice(1)));
    assert.deepEqual((await read()).errors, []);
    // Corruption of the immutable source is rejected at the write boundary.
    assert.throws(() => db.prepare("UPDATE task_log SET entry='null' WHERE task_id=(SELECT id FROM tasks WHERE external_id=?)")
        .run(h.sibling.id), /immutable/);
    assert.throws(() => db.prepare("UPDATE requests SET author='{}' WHERE id=?").run(records[1]!.requestId), /immutable/);
    const recovered = await cli(h.root, ['task', 'get', '--task', h.child.id, '--include', 'openObligations']);
    assert.equal(recovered.code, 0, recovered.stderr);
    assert.deepEqual(recovered.json.openObligations, { requests: [], returns: [] });
    assert.deepEqual(recovered.json.errors, []);
});

test('unread values are explicit', async t => {
    const h = await setup(t);
    const source = await readControlSource(h.root);
    const partial = { ...source, tasks: source.tasks.map(task => task.id === h.child.id ? { ...task, values: undefined } : task) };
    assert.throws(() => taskView(partial, h.child.id), { code: 'read_failed' });
    assert.throws(() => taskListView(partial, { text: 'Child' }), { code: 'read_failed' });
});

test('formal CLI retains SQLite conversion failures in unrelated non-body Task columns', async t => {
    const h = await setup(t);
    await url(h.root); // Start against a valid DB before injecting a read fault.
    const db = new DatabaseSync(controlDatabasePath(h.root));
    const unsafeNumber = 9007199254740993n;
    try {
        // The existing STRICT schema permits this positive 64-bit integer.
        // Selecting it must not fail when the requested Task is unrelated.
        db.prepare('UPDATE tasks SET number=? WHERE external_id=?').run(unsafeNumber, h.sibling.id);
        assert.equal(db.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
        assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
        await assert.rejects(() => readControlSource(h.root), { code: 'ERR_OUT_OF_RANGE' });
        for (const args of [['get', '--task', h.top.id], ['get', '--task', h.top.id, '--log', '0'],
            ['list'], ['list', '--text', 'Top']]) {
            const result = await cli(h.root, ['task', ...args]);
            assert.equal(result.code, 3, result.stderr);
            assert.equal(result.json, null);
            assert.equal(result.error.error.code, 'unavailable');
            assert.match(result.error.error.message, /9007199254740993/);
        }
    } finally {
        db.prepare('UPDATE tasks SET number=? WHERE number=?').run(Number(h.sibling.id.slice(1)), unsafeNumber);
        db.close();
    }
});

test('task list validates opt-in scopes and positive limits through the CLI', async t => {
    const h = await setup(t);
    for (const args of [['--in', 'history'], ['--text', 'Child', '--in', 'prompt'],
        ['--text', 'Child', '--limit', '0'], ['--text', 'Child', '--limit', '-1'],
        ['--text', 'Child', '--limit', '1.5'], ['--text', '', '--in', 'history']]) {
        assert.equal((await cli(h.root, ['task', 'list', ...args])).code, 2, args.join(' '));
    }
    // The program itself exits with the refusal's status.
    assert.equal((await cliRun(await url(h.root), ['task', 'list', '--in', 'history'])).code, 2);
    const result = await cli(h.root, ['task', 'list', '--text', 'Child', '--in', 'history,runs', '--in', 'files', '--limit', '10']);
    assert.equal(result.code, 0, result.stderr);
    assert.ok(result.json.tasks.length <= 10);
    assert.deepEqual(result.json.tasks.filter((task: any) => task.match).map((task: any) => task.id), [h.child.id, h.grandchild.id]);
    assert.equal(result.json.tasks.at(-1).match.kind, 'title');
});

test('task list searches canonical history text, requests and results, never Run prompts', async t => {
    const h = await setup(t);
    await h.commands.update({ id: h.child.id, values: { decide: [{ decide_question: 'fixed-question-only', decide_choices: [
        { decide_choice: 'Keep', decide_choice_detail: 'Nothing moves\nfixed-detail-only stays', decide_choice_recommended: 'fixed-reason-only' }],
    decide_stop: 'fixed-stop-only' }], notes: 'Original body' }, expectedTaskHash: h.child.hash });
    const question = await ask(h, h.child.id, 'old SEARCHMARK title', 'old SEARCHMARK description');
    await h.commands.update({ id: h.child.id, values: { decide: null, notes: 'Updated body' }, expectedTaskHash: (await new ControlTaskStore(h.root).get(h.child.id)).hash });
    const control = new DatabaseSync(controlDatabasePath(h.root));
    t.after(() => control.close());
    // Fixed question/answer texts and independent Requests are distinct canonical sources.
    // Fixture insertion is scoped to this synthetic root; immutable application records are never updated.
    const ordinal = Number(control.prepare('SELECT max(ordinal) AS n FROM task_log WHERE task_id=(SELECT id FROM tasks WHERE external_id=?)').get(h.child.id)!.n) + 1;
    const entry = { id: randomUUID(), kind: 'answered', questionId: question, at: '2099-01-01T00:00:00.000Z', title: 'new SEARCHMARK title',
        description: 'new SEARCHMARK description', actor: { kind: 'human' }, fromState: null, toState: null };
    control.prepare('INSERT INTO task_log(id,task_id,ordinal,entry) SELECT ?,id,?,? FROM tasks WHERE external_id=?')
        .run(entry.id, ordinal, JSON.stringify(entry), h.child.id);
    control.prepare('INSERT INTO log_texts(log_id,text) VALUES(?,?)').run(entry.id, 'fixed-answer-only');
    control.prepare('INSERT INTO task_log_question(log_id,question_log_id) VALUES(?,?)').run(entry.id, question);
    const search = (text: string, places?: readonly ('history' | 'runs')[]) => readTaskListView(h.root, { text, in: places }, null);
    assert.equal((await search('SEARCHMARK')).tasks.length, 0);
    const history = await search('searchmark', ['history']);
    const matched = history.tasks.find(task => task.id === h.child.id)!.match!;
    assert.equal(matched.kind, 'history');
    assert.ok('at' in matched && matched.at === entry.at);
    assert.equal(matched.otherMatches, 3);
    const newest = { ...entry, id: randomUUID(), kind: 'reported', questionId: undefined,
        title: 'same-time newest SEARCHMARK title', description: null };
    control.prepare('INSERT INTO task_log(id,task_id,ordinal,entry) SELECT ?,id,?,? FROM tasks WHERE external_id=?')
        .run(newest.id, ordinal + 1, JSON.stringify(newest), h.child.id);
    const tied = (await search('searchmark', ['history'])).tasks.find(task => task.id === h.child.id)!.match!;
    assert.match(tied.excerpt, /same-time newest/);
    assert.equal(tied.otherMatches, 4);

    assert.equal((await search('fixed-question-only', ['history'])).tasks.at(-1)!.id, h.child.id);
    // A question's words are every text its record fixed (a choice's description, why it is recommended, what stopping
    // means), found in History though the values no longer hold them.
    for (const word of ['fixed-detail-only', 'fixed-reason-only', 'fixed-stop-only']) {
        const found = (await search(word, ['history'])).tasks.find(task => task.id === h.child.id)?.match;
        assert.equal(found?.kind, 'history', word);
        assert.ok(found?.excerpt.includes(word), word);
        assert.equal((await search(word)).tasks.length, 0, word);
    }
    assert.equal((await search('fixed-answer-only', ['history'])).tasks.at(-1)!.id, h.child.id);
    // Requests and results created by ask use these texts; the launch prompt differs.
    assert.equal((await search('Work on it', ['history'])).tasks.at(-1)!.id, h.child.id);
    assert.equal((await search('reply', ['runs'])).tasks.at(-1)!.match!.kind, 'runs');
    const run = control.prepare('SELECT id FROM runs WHERE task_id=? LIMIT 1').get(h.child.id)!;
    assert.equal((await search('reply')).tasks.length, 0);
    assert.equal((await search('Work on it', ['runs'])).tasks.length, 0);
    assert.deepEqual((await search('reply', ['runs'])).tasks.at(-1)!.match,
        { kind: 'runs', runId: `R${run.id}`, excerpt: 'reply', otherMatches: 0 });
});

test('task list files/work respect document boundaries, visibility, ordinary hardlinks and representative priority', async t => {
    const h = await setup(t);
    const { symlinkSync, linkSync } = await import('node:fs');
    const folder = join(h.root, 'tasks', h.child.id);
    for (const path of ['', 'nested', 'node_modules', 'work', 'work/node_modules']) mkdirSync(join(folder, path), { recursive: true });
    for (const name of ['a.md', 'nested/b.txt', 'c.json', 'd.csv', 'e.html', 'work/f.md'])
        writeFileSync(join(folder, name), 'prefix FILEMARK suffix');
    for (const name of ['node_modules/excluded.md', 'work/node_modules/excluded.md', 'image.svg'])
        writeFileSync(join(folder, name), 'excluded-only');
    writeFileSync(join(folder, 'large.md'), 'oversize-only'.padEnd(1024 * 1024 + 1, 'x'));
    writeFileSync(join(folder, 'exact.md'), 'boundary-only'.padEnd(1024 * 1024, 'x'));
    symlinkSync('/does-not-exist', join(folder, 'unsafe.md'));
    linkSync(join(folder, 'a.md'), join(folder, 'hardlink.md'));
    const search = (text: string, places?: readonly ('files' | 'work')[], extra = {}) =>
        readTaskListView(h.root, { text, in: places, ...extra }, null);
    assert.deepEqual((await search('FILEMARK')).errors, []);
    const files = await search('filemark', ['files']);
    assert.deepEqual(files.tasks.at(-1)!.match, { kind: 'files', path: 'a.md', excerpt: 'prefix FILEMARK suffix', otherMatches: 5 });
    assert.deepEqual(files.errors, [], 'ordinary hardlinks are readable; descendant symbolic links are omitted by the recursive search');
    const work = await search('filemark', ['work']);
    assert.deepEqual(work.tasks.at(-1)!.match, { kind: 'work', path: 'work/f.md', excerpt: 'prefix FILEMARK suffix', otherMatches: 0 });
    assert.deepEqual(work.errors, []);
    assert.equal((await search('filemark', ['work', 'files'])).tasks.at(-1)!.match!.kind, 'files');
    assert.equal((await search('excluded-only', ['files', 'work'])).tasks.length, 0);
    assert.equal((await search('oversize-only', ['files'])).tasks.length, 0);
    assert.equal((await search('boundary-only', ['files'])).tasks.at(-1)!.id, h.child.id);
    assert.equal((await search('FILEMARK', ['files'], { under: h.sibling.id })).errors.length, 0);
    await h.commands.update({ id: h.child.id, values: { notes: 'FILEMARK' }, expectedTaskHash: (await new ControlTaskStore(h.root).get(h.child.id)).hash });
    assert.equal((await search('FILEMARK', ['work', 'files'])).tasks.at(-1)!.match!.kind, 'values');
    await h.commands.lifecycle({ id: h.grandchild.id, action: 'delete', expectedTaskHash: h.grandchild.hash });
    await h.commands.lifecycle({ id: h.child.id, action: 'archive', expectedTaskHash: (await new ControlTaskStore(h.root).get(h.child.id)).hash });
    assert.equal((await search('FILEMARK', ['files'])).errors.length, 0);
    assert.equal((await search('FILEMARK', ['files'], { all: true })).tasks.at(-1)!.id, h.child.id);
    const projectFolder = join(h.root, 'tasks', h.project);
    mkdirSync(projectFolder, { recursive: true });
    writeFileSync(join(projectFolder, 'foreign.md'), 'foreign-project-file-only');
    assert.equal((await readTaskListView(h.root, { text: 'foreign-project-file-only', in: ['files'] }, 'P1')).tasks.length, 0,
        'project headers in a Run tree do not grant access to another project folder');
    assert.equal((await readTaskListView(h.root, { text: 'FILEMARK', in: ['files'], all: true }, 'P1')).errors.length, 0,
        'a Run in another project never opens this Task folder');
});

test('task list pages ancestors and matching siblings without repeating earlier rows', async t => {
    const h = await setup(t);
    const created = (await h.commands.create({ parentId: h.child.id, userRequested: false,
        tasks: Array.from({ length: 55 }, (_, index) => ({ title: `limitneedle ${index}`, values: { notes: 'bodyneedle' } })) })).tasks;
    const query = { text: 'limitneedle', limit: 25 };
    const first = await cli(h.root, ['task', 'list', '--text', query.text, '--limit', String(query.limit)]);
    assert.equal(first.code, 0, first.stderr);
    assert.equal(first.json.tasks.length, 25);
    assert.equal(first.json.tasks.find((task: any) => task.id === h.child.id).match, undefined);
    const appended = (await h.commands.create({ parentId: h.child.id, userRequested: false,
        tasks: [{ title: 'limitneedle new sibling' }] })).tasks[0]!;
    const seen = first.json.tasks.filter((task: any) => task.match).map((task: any) => task.id);
    let cursor = first.json.cursor;
    await assert.rejects(readTaskListView(h.root, { ...query, text: 'other', cursor }, null), { code: 'invalid_input' });
    while (cursor) {
        const page = await readTaskListView(h.root, { ...query, cursor }, null);
        assert.ok(page.tasks.length <= query.limit);
        seen.push(...page.tasks.filter(row => row.match).map(row => row.id));
        cursor = page.cursor;
    }
    assert.deepEqual(seen, [...created, appended].map(task => task.id));
    const byId = await readTaskListView(h.root, { text: created.at(-1)!.id }, null);
    assert.equal(byId.tasks.at(-1)!.match!.kind, 'id');
    const byBody = await readTaskListView(h.root, { text: 'bodyneedle', in: ['history'] }, null);
    assert.equal(byBody.tasks.at(-1)!.match!.kind, 'values', '--in always adds to the base fields');
    assert.equal((await readTaskListView(h.root, { text: '0bodyneedle' }, null)).tasks.length, 0, 'one query cannot span fields');
});

test('task list default reads no history, requests, Runs, or files; scoped failures are partial CLI results', async t => {
    const h = await setup(t);
    let extraRows = 0;
    const prepare = DatabaseSync.prototype.prepare;
    DatabaseSync.prototype.prepare = function(query: string) {
        const statement = prepare.call(this, query), all = statement.all, iterate = statement.iterate;
        if (/\b(FROM|JOIN)\s+(task_log|log_texts|requests|runs)\b/i.test(query)) statement.all = function(...args) {
            const rows = all.apply(this, args); extraRows += rows.length; return rows;
        };
        statement.iterate = function(...args) { extraRows++; return iterate.apply(this, args); };
        return statement;
    };
    try {
        await readTaskListView(h.root, { text: 'Child' }, null);
        assert.equal(extraRows, 0, 'no additional records are returned by SQLite');
    } finally { DatabaseSync.prototype.prepare = prepare; }
    const runs = new RunStore(h.root, { busyTimeoutMs: 0 });
    try {
        runs.write(tx => {
            const run = createFixtureRun(runs, tx, fields({ task: h.child.id }), 'prompt-only-needle');
            const started = { ...run, state: 'running' as const, started_at: new Date().toISOString() };
            tx.update(started);
            tx.finish({ ...started, state: 'failed', reason: 'output', ended_at: new Date().toISOString() }, { state: 'unreadable', text: null });
        });
    } finally { runs.close(); }
    const plain = await cli(h.root, ['task', 'list', '--text', 'prompt-only-needle']);
    assert.equal(plain.code, 0);
    assert.deepEqual(plain.json.errors, []);
    const failed = await cli(h.root, ['task', 'list', '--text', 'prompt-only-needle', '--in', 'runs']);
    assert.equal(failed.code, 4);
    assert.deepEqual(failed.json.tasks, []);
    assert.equal(failed.json.errors.length, 1);
    assert.match(failed.json.errors[0].path, /^R\d+\/result$/);
    const request = await cli(h.root, ['task', 'list', '--text', 'prompt-only-needle', '--in', 'history']);
    assert.equal(request.code, 0);
    assert.equal(request.json.tasks.at(-1).id, h.child.id, 'Requests without a history reference remain searchable');
});

test('task list keeps Unicode, multiline substring and one-match-per-field semantics in file excerpts', async t => {
    const h = await setup(t);
    const folder = join(h.root, 'tasks', h.child.id);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'unicode.md'), '😀'.repeat(90) + 'ÉCOLE\nnext' + '😀'.repeat(90) + '\nÉCOLE\nnext');
    const result = await readTaskListView(h.root, { text: 'école\nNEXT', in: ['files'] }, null);
    const match = result.tasks.at(-1)!.match!;
    assert.equal(match.kind, 'files');
    assert.match(match.excerpt, /ÉCOLE next/);
    assert.equal(match.otherMatches, 0, 'multiple occurrences in one file remain one matching field');
    assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(match.excerpt), false);
    assert.ok([...match.excerpt].length <= 82);
});

test('review 1: search refuses unpublished Task files through the same boundary as normal reads', async t => {
    const h = await setup(t);
    const { FileJournal } = await import('@alpacawork/backend/test-dist/control/file-journal.js');
    const { readTaskFile } = await import('@alpacawork/backend/test-dist/control/task-files.js');
    for (const name of ['pending.txt', 'work/pending.txt']) {
        assert.throws(() => new FileJournal(h.root, phase => { if (phase === 'renamed') throw Error('simulated crash'); })
            .putTaskFile({ task: h.child.id, name, opId: randomUUID(), bytes: Buffer.from('prepared-content'), result: {},
                grant: () => ({ actor: { kind: 'human' }, task: h.child.id }) }), /simulated crash/);
        writeFileSync(join(h.root, 'tasks', h.child.id, name), 'unconfirmed-marker');
    }
    assert.deepEqual(new FileJournal(h.root).recover(), { published: 0, needsReview: 2 });
    await assert.rejects(readTaskFile(h.root, h.child.id, 'pending.txt'), { code: 'busy' });
    const normal = await fetch(new URL(`/api/tasks/${h.child.id}/file?path=pending.txt`, await url(h.root)));
    assert.equal(normal.status, 409);
    for (const place of ['files', 'work']) {
        const result = await cli(h.root, ['task', 'list', '--text', 'unconfirmed-marker', '--in', place]);
        assert.equal(result.code, 4, result.stdout);
        assert.deepEqual(result.json.tasks, []);
        assert.equal(result.json.errors.length, 1);
        assert.match(result.json.errors[0].message, /publication is pending/);
    }
    const latePath = `tasks/${h.child.id}/late.txt`;
    new FileJournal(h.root).withFileReads(available => {
        assert.equal(available(latePath, () => 'not reserved yet'), 'not reserved yet');
        assert.throws(() => new FileJournal(h.root, phase => { if (phase === 'reserved') throw Error('late reservation'); })
            .putTaskFile({ task: h.child.id, name: 'late.txt', opId: randomUUID(), bytes: Buffer.from('later'), result: {},
                grant: () => ({ actor: { kind: 'human' }, task: h.child.id }) }), /late reservation/);
        assert.throws(() => available(latePath, () => assert.fail('reserved bytes must not be read')), { code: 'busy' });
    });
});

test('review 2: missing Run results are absent content while too_large and unreadable remain errors', async t => {
    const h = await setup(t);
    const add = (state: 'missing' | 'too_large' | 'unreadable') => {
        const runs = new RunStore(h.root, { busyTimeoutMs: 0 });
        try { return runs.write(tx => {
            const run = createFixtureRun(runs, tx, fields({ task: h.child.id }), 'not-a-result');
            const started = { ...run, state: 'running' as const, started_at: new Date().toISOString() };
            tx.update(started);
            tx.finish({ ...started, state: 'failed', reason: 'output', ended_at: new Date().toISOString() }, { state, text: null });
            return run.id;
        }); } finally { runs.close(); }
    };
    const missing = add('missing');
    const absent = await cli(h.root, ['task', 'list', '--text', 'no-such-needle', '--in', 'runs']);
    assert.equal(absent.code, 0, absent.stdout);
    assert.deepEqual(absent.json.errors, []);
    assert.deepEqual(absent.json.tasks, []);
    const tooLarge = add('too_large'), unreadable = add('unreadable');
    const failed = await cli(h.root, ['task', 'list', '--text', 'no-such-needle', '--in', 'runs']);
    assert.equal(failed.code, 4);
    assert.deepEqual(failed.json.errors.map((error: any) => error.path).sort(), [`${tooLarge}/result`, `${unreadable}/result`].sort());
    assert.equal(failed.json.errors.some((error: any) => error.path === `${missing}/result`), false);
});

test('review 3: invalid UTF-8 is an explicit read failure in files and work, never replacement text', async t => {
    const h = await setup(t), folder = join(h.root, 'tasks', h.child.id);
    mkdirSync(join(folder, 'work'), { recursive: true });
    for (const name of ['invalid.txt', 'work/invalid.txt']) writeFileSync(join(folder, name), Buffer.from([0xff]));
    assert.deepEqual((await readTaskListView(h.root, { text: '�' }, null)).errors, []);
    for (const place of ['files', 'work']) for (const text of ['�', 'no-such-needle']) {
        const result = await cli(h.root, ['task', 'list', '--text', text, '--in', place]);
        assert.equal(result.code, 4, result.stdout);
        assert.deepEqual(result.json.tasks, []);
        assert.equal(result.json.errors.length, 1);
        assert.match(result.json.errors[0].path, /invalid\.txt$/);
    }
});

test('review 4: unknown directory entry types use the same filesystem classification as taskFiles', async t => {
    const h = await setup(t), folder = join(h.root, 'tasks', h.child.id);
    const { taskFiles } = await import('@alpacawork/backend/test-dist/control/task-files.js');
    for (const name of ['nested', 'work/nested']) {
        mkdirSync(join(folder, name), { recursive: true });
        writeFileSync(join(folder, name, 'result.txt'), 'unknown-directory-marker');
    }
    const entries = FileWriter.prototype.entries;
    FileWriter.prototype.entries = function(fd: number) { return entries.call(this, fd).map(entry => ({ ...entry, type: 0 })); };
    try {
        const writer = new FileWriter(h.root);
        try { assert.deepEqual(taskFiles(writer, [`tasks/${h.child.id}`]).get(`tasks/${h.child.id}`)!.map(file => file.name),
            ['nested/result.txt', 'work/nested/result.txt']); } finally { writer.close(); }
        for (const place of ['files', 'work'] as const) {
            const result = await readTaskListView(h.root, { text: 'unknown-directory-marker', in: [place] }, null);
            assert.deepEqual(result.errors, []);
            const match = result.tasks.find(task => task.id === h.child.id)?.match;
            assert.ok(match, place);
            assert.equal(match.kind, place);
            assert.ok('path' in match && match.path === `${place === 'work' ? 'work/' : ''}nested/result.txt`);
        }
    } finally { FileWriter.prototype.entries = entries; }
});

test('review 5: excerpts map length-changing lowercase matches back to original text', async t => {
    const h = await setup(t), folder = join(h.root, 'tasks', h.child.id);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'unicode.txt'), 'İ'.repeat(100) + 'NEEDLE');
    const result = await cli(h.root, ['task', 'list', '--text', 'needle', '--in', 'files']);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.json.tasks.at(-1).match.excerpt, /NEEDLE/);
    const { TaskTextMatches } = await import('@alpacawork/backend/test-dist/control/task-search.js');
    for (const kind of ['title', 'values', 'history', 'runs', 'files', 'work'] as const) {
        const matches = new TaskTextMatches('needle');
        const source = kind === 'history' ? { kind, at: new Date().toISOString(), type: 'reported' }
            : kind === 'runs' ? { kind, runId: 'R1' } : kind === 'files' || kind === 'work' ? { kind, path: 'a.txt' } : { kind };
        matches.add('T1', source, 'İ'.repeat(100) + '😀NEEDLE');
        assert.match(matches.matches.get('T1')!.excerpt, /😀NEEDLE/);
    }
    const reordered = new TaskTextMatches('needle');
    reordered.add('T1', { kind: 'work', path: 'work/a.txt' }, 'needle in work');
    reordered.add('T1', { kind: 'files', path: 'z.txt' }, 'needle in files');
    assert.equal(reordered.matches.get('T1')!.kind, 'files', 'shared traversal order cannot change source priority');
    assert.equal(reordered.matches.get('T1')!.otherMatches, 1);
    const expanded = new TaskTextMatches('\u0307');
    expanded.add('T1', { kind: 'values' }, 'İ');
    assert.equal(expanded.matches.get('T1')!.excerpt, 'İ', 'a match inside an expanded lowercase letter maps to that letter');
});


for (const place of ['files', 'work'] as const) for (const kind of ['symlink', 'file'] as const) {
    test(`review root: ${place} reports a ${kind} search origin without changing ordinary file access`, async t => {
        const h = await setup(t);
        const { symlinkSync } = await import('node:fs');
        const { taskFiles, readTaskFile } = await import('@alpacawork/backend/test-dist/control/task-files.js');
        const folder = `tasks/${h.child.id}`;
        const origin = place === 'work' ? `${folder}/work` : folder;
        const outside = join(h.root, 'outside');
        mkdirSync(outside);
        writeFileSync(join(outside, 'marker.txt'), 'outside-secret');
        mkdirSync(join(h.root, 'tasks'), { recursive: true });
        if (place === 'work') mkdirSync(join(h.root, folder), { recursive: true });
        if (kind === 'symlink') symlinkSync(outside, join(h.root, origin));
        else writeFileSync(join(h.root, origin), 'outside-secret');
        const writer = new FileWriter(h.root);
        try { assert.deepEqual(taskFiles(writer, [folder]).get(folder)!.map(file => file.name),
            place === 'work' && kind === 'file' ? ['work'] : []); }
        finally { writer.close(); }
        const filename = `${place === 'work' ? 'work/' : ''}marker.txt`;
        if (kind === 'symlink') assert.equal((await readTaskFile(h.root, h.child.id, filename)).toString('utf8'), 'outside-secret');
        else await assert.rejects(readTaskFile(h.root, h.child.id, filename), error => {
            assert.equal((error as { code: string }).code, 'unsafe_path');
            const ordinary = new FileWriter(h.root);
            try { assert.throws(() => ordinary.directory(origin), { code: 'ENOTDIR' }); } finally { ordinary.close(); }
            return true;
        });
        const result = await cli(h.root, ['task', 'list', '--under', h.child.id, '--text', 'outside-secret', '--in', place]);
        if (kind === 'symlink') {
            assert.equal(result.code, 0, result.stdout); assert.deepEqual(result.json.errors, []);
            assert.deepEqual(result.json.tasks, [], 'recursive search omits directory links instead of treating them as an access fault');
            rmSync(join(h.root, origin));
            const { renameSync } = await import('node:fs'); renameSync(outside, join(h.root, origin));
            const found = await cli(h.root, ['task', 'list', '--under', h.child.id, '--text', 'outside-secret', '--in', place]);
            assert.equal(found.code, 0, found.stdout); assert.deepEqual(found.json.errors, []);
            assert.equal(found.json.tasks.length, 1); assert.equal(found.json.tasks[0].id, h.child.id);
            assert.equal(found.json.tasks[0].match.kind, place);
        } else {
            assert.equal(result.code, 4, result.stdout); assert.deepEqual(result.json.tasks, []);
            assert.equal(result.json.errors.length, 1); assert.equal(result.json.errors[0].code, 'read_failed');
            assert.equal(result.json.errors[0].path, origin); assert.match(result.json.errors[0].message, /ENOTDIR/);
        }
    });
}

test('review root: missing origins and excluded descendant links remain empty without errors', async t => {
    const h = await setup(t);
    const { symlinkSync } = await import('node:fs');
    const folder = join(h.root, 'tasks', h.child.id);
    const search = (place: 'files' | 'work') => readTaskListView(h.root,
        { under: h.child.id, text: 'outside-secret', in: [place] }, null);
    for (const place of ['files', 'work'] as const) {
        const missing = await search(place);
        assert.deepEqual(missing.tasks, []);
        assert.deepEqual(missing.errors, []);
    }
    mkdirSync(folder, { recursive: true });
    assert.deepEqual((await search('work')).errors, [], 'a missing work origin is also absent content');
    mkdirSync(join(folder, 'work'));
    const outside = join(h.root, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'marker.txt'), 'outside-secret');
    for (const name of ['nested-link', 'work/nested-link']) symlinkSync(outside, join(folder, name));
    for (const place of ['files', 'work'] as const) {
        const excluded = await search(place);
        assert.deepEqual(excluded.tasks, []);
        assert.deepEqual(excluded.errors, [], 'links below the origin keep ordinary listing exclusion rules');
    }
});


for (const place of ['files', 'work'] as const) {
    test(`review root: ${place} origin disappearing before open is still ENOENT, not a read fault`, async t => {
        const h = await setup(t), folder = join(h.root, 'tasks', h.child.id);
        const origin = place === 'work' ? join(folder, 'work') : folder;
        mkdirSync(origin, { recursive: true });
        const entries = FileWriter.prototype.entries;
        let removed = false;
        FileWriter.prototype.entries = function(fd: number) {
            const result = entries.call(this, fd);
            if (!removed && result.some(entry => entry.name === (place === 'work' ? 'work' : h.child.id))) {
                rmSync(origin, { recursive: true }); removed = true;
            }
            return result;
        };
        try {
            const result = await readTaskListView(h.root, { under: h.child.id, text: 'absent', in: [place] }, null);
            assert.equal(removed, true);
            assert.deepEqual(result.tasks, []);
            assert.deepEqual(result.errors, []);
        } finally { FileWriter.prototype.entries = entries; }
    });
}
