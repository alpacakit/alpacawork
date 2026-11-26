/** Who may do what: the one table of acts, decided purely from the caller, the action and the Task's facts. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Problem } from '@alpacawork/core';
import type { TaskState } from '@alpacawork/raw';
import { ACTIONS, decide, type Act, type Action, type Caller, type Decision, type Quote, type TaskFacts } from
  '@alpacawork/backend/test-dist/control/authorize.js';

const said: Quote = 'Proceed with that';
const policy: Quote = 'You may manage the preview server';
const run = (taskId: string, placementId: string, role: 'owner' | 'worker' = 'owner'): Caller =>
  ({ kind: 'run', runId: `R${placementId.slice(1)}`, placementId, taskId, role, responsible: role === 'owner' });
const coordinator: Caller = { kind: 'coordinator', source: 'claude', conversation: 'S1' };
/**
 * The callers every row is tried with: Runs of project P1 (T2 the parent of T3, T4 a sibling) and of project P10, and
 * the parent's Run while the user holds T2. A Run's own Task is at work, unless it is the Task acted on.
 */
const CALLERS = {
  own: { caller: run('T3', 'P3'), quote: null, runProject: 'P1', runState: 'doing' },
  parent: { caller: run('T2', 'P2'), quote: null, runProject: 'P1', runState: 'doing' },
  heldParent: { caller: run('T2', 'P2'), quote: null, runProject: 'P1', runState: 'held' },
  worker: { caller: run('T3', 'P4', 'worker'), quote: null, runProject: 'P1', runState: 'doing' },
  sibling: { caller: run('T4', 'P5'), quote: null, runProject: 'P1', runState: 'doing' },
  foreign: { caller: run('T20', 'P9'), quote: null, runProject: 'P10', runState: 'doing' },
  human: { caller: { kind: 'human' }, quote: null, runProject: null, runState: null },
  coordinator: { caller: coordinator, quote: null, runProject: null, runState: null },
  policy: { caller: coordinator, quote: policy, runProject: null, runState: null },
  utterance: { caller: coordinator, quote: said, runProject: null, runState: null },
} satisfies Record<string, { caller: Caller; quote: Quote | null; runProject: string | null; runState: TaskState | null }>;
type Who = keyof typeof CALLERS;
const everyone = Object.keys(CALLERS) as Who[];
const proxies: Who[] = ['human', 'coordinator', 'policy', 'utterance'];
const coordinators: Who[] = ['coordinator', 'policy', 'utterance'];

const child = (overrides: Partial<TaskFacts> = {}): TaskFacts => ({ id: 'T3', kind: 'task', parentId: 'T2',
  project: 'P1', state: 'doing', userRequested: false, baseState: overrides.baseState ?? (overrides.state === 'held' ? 'doing' : overrides.state ?? 'doing'), hold: overrides.state === 'held', ...overrides });
const top = (overrides: Partial<TaskFacts> = {}) => child({ parentId: 'P1', ...overrides });
const project: TaskFacts = { id: 'P1', kind: 'project', parentId: null, project: 'P1', state: 'todo',
  userRequested: false, baseState: 'todo', hold: false };
const held = child({ state: 'held' });
const review = child({ state: 'waiting', userRequested: true});
const heldReview = child({ state: 'held', baseState: 'waiting', userRequested: true});
const userFailure = child({ state: 'error', userRequested: true });

const as = (who: Who, action: Action, task: TaskFacts | null): Decision | Problem => {
  const { caller, quote, runProject, runState } = CALLERS[who];
  return decide(caller, action, { task, runProject, quote,
    runState: caller.kind === 'run' && caller.taskId === task?.id ? task.state : runState });
};
const allowed = (result: Decision | Problem): result is Decision => !(result instanceof Problem);

/** Each row of the table, with every caller it lets act; everyone else is refused with that row named. */
const cases: { act: Act; action: Action; task: TaskFacts | null; allow: readonly Who[]; note?: string;
  refusals?: Partial<Record<Who, Act>> }[] = [
  { act: 'task.checkpoint', action: { name: 'task.report', state: 'doing', checkpoint: true }, task: child(), allow: ['own'] },
  { act: 'task.read', action: { name: 'task.read' }, task: child(), allow: everyone.filter(who => who !== 'foreign') },
  { act: 'task.read', action: { name: 'task.read' }, task: project, allow: everyone.filter(who => who !== 'foreign'),
    note: 'a Run reads its own project Task' },
  { act: 'task.list', action: { name: 'task.list' }, task: null, allow: everyone },
  { act: 'task.new.child', action: { name: 'task.new', kind: 'task', userRequested: false }, task: child(),
    allow: ['own'], note: 'below the Run\'s own Task, unmarked' },
  { act: 'task.new.child', action: { name: 'task.new', kind: 'task', userRequested: false }, task: held,
    allow: [], note: 'not below a held Task by its responsible' },
  { act: 'task.new', action: { name: 'task.new', kind: 'task', userRequested: false }, task: project, allow: proxies },
  { act: 'task.new.from_user', action: { name: 'task.new', kind: 'task', userRequested: true }, task: child(),
    allow: proxies },
  { act: 'task.new.project', action: { name: 'task.new', kind: 'project', userRequested: null }, task: project,
    allow: proxies },
  { act: 'task.new.project', action: { name: 'task.new', kind: 'project', userRequested: null }, task: null,
    allow: proxies, note: 'a root project' },
  { act: 'task.update.title', action: { name: 'task.update', fields: ['title'] }, task: child(), allow: ['own', 'parent', ...proxies] },
  { act: 'task.update.title', action: { name: 'task.update', fields: ['title'] }, task: held, allow: ['parent', ...proxies] },
  { act: 'task.update.values', action: { name: 'task.update', fields: ['values'] }, task: child(), allow: ['own', 'parent', ...proxies] },
  { act: 'task.update.values', action: { name: 'task.update', fields: ['values'] }, task: held, allow: ['parent', ...proxies] },
  { act: 'task.update.values', action: { name: 'task.update', fields: ['values'] }, task: project, allow: proxies,
    note: 'a project\'s values are its policy' },
  { act: 'task.update.analysisSubject', action: { name: 'task.update', fields: ['analysisSubject'] },
    task: child(), allow: ['own', 'parent', ...proxies] },
  { act: 'task.update.cwd', action: { name: 'task.update', fields: ['cwd'] }, task: project, allow: proxies },
  { act: 'task.update.color', action: { name: 'task.update', fields: ['color'] }, task: project, allow: proxies },
  { act: 'task.update.userRequested', action: { name: 'task.update', fields: ['userRequested'] }, task: child(),
    allow: proxies },
  { act: 'task.update.title', action: { name: 'task.update', fields: ['title', 'values'] }, task: child(),
    allow: ['own', 'parent', ...proxies], note: 'every field is allowed, or none' },
  { act: 'task.move', action: { name: 'task.move', to: ['T5', 'T2', 'P1'] }, task: child(), allow: ['parent', ...proxies] },
  { act: 'task.move', action: { name: 'task.move', to: ['T6', 'P1'] }, task: child(), allow: proxies,
    note: 'out from below the parent Run\'s own Task' },
  { act: 'task.archive', action: { name: 'task.archive' }, task: child(), allow: proxies },
  { act: 'task.delete', action: { name: 'task.delete' }, task: child(), allow: proxies },
  { act: 'task.restore', action: { name: 'task.restore' }, task: child(), allow: proxies },
  { act: 'task.report.doing', action: { name: 'task.report', state: 'doing' }, task: child(), allow: ['own'] },
  { act: 'task.report.doing', action: { name: 'task.report', state: 'doing' }, task: held, allow: ['own', 'parent', ...proxies],
    note: 'own progress retains hold; managers restore',
    refusals: { heldParent: 'task.report.restore', sibling: 'task.report.restore', foreign: 'task.report.restore' } },
  { act: 'task.report.waiting', action: { name: 'task.report', state: 'waiting' }, task: child(), allow: ['own', ...proxies],
 note: 'Runs ask; the proxy submits for review (state checked by the transition)' },
  { act: 'task.report.waiting', action: { name: 'task.report', state: 'waiting' }, task: heldReview, allow: ['own', 'parent', ...proxies],
    refusals: { heldParent: 'task.report.restore', sibling: 'task.report.restore', foreign: 'task.report.restore' } },
  { act: 'task.review', action: { name: 'task.report', state: 'waiting' }, task: child({ state: 'done', userRequested: true }),
    allow: ['own', ...proxies], refusals: { parent: 'task.report.waiting', heldParent: 'task.report.waiting',
      worker: 'task.report.waiting', sibling: 'task.report.waiting', foreign: 'task.report.waiting' } },
  { act: 'task.report.done', action: { name: 'task.report', state: 'done' }, task: child(), allow: ['own'] },
  { act: 'task.report.done', action: { name: 'task.report', state: 'done' }, task: held, allow: [] },
  { act: 'task.confirm', action: { name: 'task.report', state: 'done', confirmation: true }, task: review, allow: proxies },
  { act: 'task.confirm', action: { name: 'task.report', state: 'done', confirmation: true }, task: heldReview, allow: proxies },
  { act: 'task.report.stopped', action: { name: 'task.report', state: 'stopped' }, task: child(),
    allow: ['own', 'parent', ...proxies] },
  { act: 'task.report.stopped', action: { name: 'task.report', state: 'stopped' }, task: held, allow: ['parent', ...proxies] },
  { act: 'task.report.stopped.user', action: { name: 'task.report', state: 'stopped' }, task: userFailure, allow: proxies },
  { act: 'task.report.stopped.user', action: { name: 'task.report', state: 'stopped' }, task: review, allow: proxies },
  { act: 'task.report.restore', action: { name: 'task.report', state: 'todo' }, task: child({ state: 'held', baseState: 'todo' }), allow: ['parent', ...proxies] },
  { act: 'task.report.held', action: { name: 'task.report', state: 'held' }, task: review, allow: proxies },
  { act: 'task.withdraw', action: { name: 'task.withdraw' }, task: held, allow: ['own'] },
  { act: 'task.comment', action: { name: 'task.comment', urgent: false }, task: held, allow: everyone.filter(who => who !== 'foreign') },
  { act: 'task.comment.urgent', action: { name: 'task.comment', urgent: true }, task: child(), allow: ['own'] },
  { act: 'task.comment.urgent', action: { name: 'task.comment', urgent: true }, task: held, allow: ['own'],
    note: 'an urgent comment is a record too' },
  { act: 'task.request', action: { name: 'task.request', worker: false }, task: child(), allow: ['parent', ...proxies] },
  { act: 'task.request', action: { name: 'task.request', worker: false }, task: top(), allow: ['human', ...coordinators],
    note: 'the coordinator instructs a top Task\'s responsible without the user\'s words' },
  { act: 'task.request', action: { name: 'task.request', worker: false }, task: child({ state: 'error' }),
    allow: ['parent', ...proxies], note: 'a failed Task an agent asked for is the parent\'s to retry' },
  { act: 'task.request.user', action: { name: 'task.request', worker: false }, task: userFailure, allow: proxies },
  { act: 'task.request.user', action: { name: 'task.request', worker: false }, task: top({ state: 'error', userRequested: true }),
    allow: proxies },
  { act: 'task.request', action: { name: 'task.request', worker: false }, task: review, allow: ['parent', ...proxies],
    note: 'ordinary input to a review uses the same parent/user instruction authority' },
  { act: 'task.request.worker', action: { name: 'task.request', worker: true }, task: child(), allow: ['own'] },
  { act: 'task.request.worker', action: { name: 'task.request', worker: true }, task: held, allow: [] },
  { act: 'task.answer', action: { name: 'task.answer', askedTo: null }, task: child(), allow: proxies },
  { act: 'task.answer', action: { name: 'task.answer', askedTo: 'T2' }, task: child(), allow: ['parent'] },
  { act: 'agent.assign', action: { name: 'agent.assign', worker: false }, task: child(), allow: ['parent', ...proxies] },
  { act: 'agent.assign', action: { name: 'agent.assign', worker: false }, task: top(), allow: ['human', ...coordinators] },
  { act: 'agent.handover', action: { name: 'agent.handover' }, task: child(), allow: ['parent', ...proxies] },
  { act: 'agent.handover', action: { name: 'agent.handover' }, task: top(), allow: ['human', ...coordinators] },
  { act: 'agent.release', action: { name: 'agent.release', worker: false }, task: child(), allow: ['parent', ...proxies] },
  { act: 'agent.release', action: { name: 'agent.release', worker: false }, task: top(), allow: ['human', ...coordinators] },
  { act: 'agent.assign.worker', action: { name: 'agent.assign', worker: true }, task: top(), allow: ['own', ...proxies] },
  { act: 'agent.assign.worker', action: { name: 'agent.assign', worker: true }, task: held, allow: proxies },
  { act: 'agent.release.worker', action: { name: 'agent.release', worker: true }, task: child(), allow: ['own', ...proxies] },
  { act: 'agent.release.worker', action: { name: 'agent.release', worker: true }, task: held, allow: proxies },
  { act: 'run.stop', action: { name: 'run.stop' }, task: child(), allow: ['parent', ...proxies] },
  { act: 'run.stop', action: { name: 'run.stop' }, task: top(), allow: ['human', ...coordinators] },
  { act: 'file.write', action: { name: 'file.write' }, task: child(), allow: ['own', 'worker', 'human'] },
  { act: 'config.inspect', action: { name: 'config.inspect' }, task: null, allow: proxies },
  { act: 'config.set', action: { name: 'config.set' }, task: null, allow: proxies },
  ...(['settings.read', 'settings.set'] as const).map(act => ({ act, action: { name: act }, task: null, allow: proxies,
    note: 'the person\'s own settings: a Run hears the user only through quoted words' })),
  { act: 'field.list', action: { name: 'field.list' }, task: null, allow: everyone },
  { act: 'field.set', action: { name: 'field.set' }, task: null, allow: proxies, note: 'definitions are shared by every project' },
  { act: 'field.delete', action: { name: 'field.delete' }, task: null, allow: proxies },
  { act: 'field.use', action: { name: 'field.use' }, task: project, allow: ['own', 'parent', 'sibling', ...proxies],
    note: 'a responsible Run of a Task in the project, never a member or another project\'s' },
  ...(['update.review', 'update.confirm', 'update.cancel', 'screen', 'coordinator.screen', 'runtime', 'admin'] as const)
    .map(name => ({ act: name, action: { name }, task: null, allow: ['human'] as Who[] })),
  { act: 'release', action: { name: 'release' }, task: child(), allow: ['own', 'human'],
    note: "decided on the Run's own Task: its responsible's Run, never its worker's" },
  { act: 'release', action: { name: 'release' }, task: held, allow: ['human'] },
];

test('every act in the table lets exactly its callers act, and names itself when it refuses', () => {
  for (const { act, action, task, allow, note, refusals } of cases) {
    for (const who of everyone) {
      const result = as(who, action, task);
      const label = `${act}${note ? ` (${note})` : ''} as ${who}`;
      if (allow.includes(who)) assert.ok(allowed(result), `${label}: ${result instanceof Problem ? result.message : ''}`);
      else {
        assert.ok(result instanceof Problem, `${label} is refused`);
        assert.equal(result.code, 'forbidden', label);
        assert.deepEqual(result.detail, { action: refusals?.[who] ?? act }, label);
      }
    }
  }
});

test('the cases try every act in the table', () => {
  assert.deepEqual([...new Set(cases.map(item => item.act))].sort(), Object.keys(ACTIONS).sort());
});

test('the actor is the Run\'s placement, a person, or the coordinator\'s conversation with the words it quoted', () => {
  const actor = (who: Who, caller = CALLERS[who].caller) => {
    const result = decide(caller, { name: 'task.read' }, { task: child(), runProject: CALLERS[who].runProject,
      runState: CALLERS[who].runState, quote: CALLERS[who].quote });
    assert.ok(allowed(result));
    return result.actor;
  };
  assert.deepEqual(actor('own'), { kind: 'placement', placementId: 'P3' });
  assert.deepEqual(actor('worker'), { kind: 'placement', placementId: 'P4' });
  assert.deepEqual(actor('human'), { kind: 'human' });
  assert.deepEqual(actor('coordinator'), { kind: 'main', provider: 'claude', conversationId: 'S1' });
  assert.deepEqual(actor('utterance'), { kind: 'main', provider: 'claude', conversationId: 'S1', quote: said });
  assert.deepEqual(actor('policy'), { kind: 'main', provider: 'claude', conversationId: 'S1', quote: policy });
  const screen: Caller = { kind: 'coordinator', source: 'screen', provider: 'codex', conversation: 'C1', runId: 'R1' };
  assert.deepEqual(actor('coordinator', screen), { kind: 'main', provider: 'codex', conversationId: 'C1' },
    'the screen\'s coordinator speaks through its Run\'s agent');
});

test('a Run reads only its own project; a person and the coordinator read every project', () => {
  const scope = (who: Who) => {
    const result = as(who, { name: 'task.list' }, null);
    assert.ok(allowed(result));
    return result.readScope;
  };
  assert.equal(scope('own'), 'P1');
  assert.equal(scope('worker'), 'P1');
  assert.equal(scope('foreign'), 'P10');
  for (const who of ['human', ...coordinators] as Who[]) assert.equal(scope(who), null, who);
  const write = as('own', { name: 'task.report', state: 'doing' }, child());
  assert.ok(allowed(write));
  assert.equal(write.readScope, 'P1', 'a Run\'s write answers within its project too');
  const unread = decide(run('T3', 'P3'), { name: 'task.list' }, { task: null, runProject: null, runState: null, quote: null });
  assert.ok(unread instanceof Problem && unread.code === 'forbidden', 'a Run whose project was not read reads nothing');
});

test('the coordinator says whose Task it creates; a Run never creates the user\'s request', () => {
  const unstated: Action = { name: 'task.new', kind: 'task', userRequested: null };
  for (const who of coordinators) {
    const result = as(who, unstated, child());
    assert.ok(result instanceof Problem && result.code === 'invalid_input', who);
    assert.deepEqual(result.issues?.map(issue => issue.path), ['fromUser']);
  }
  assert.ok(allowed(as('own', unstated, child())), 'a Run\'s Task is unmarked');
  assert.ok(allowed(as('human', unstated, project)), 'a person\'s default is the user\'s request');
  assert.ok(allowed(as('coordinator', { name: 'task.new', kind: 'task', userRequested: false }, project)),
    '--no-from-user needs no quote below a project');
  assert.ok(allowed(as('policy', { name: 'task.new', kind: 'task', userRequested: true }, child())));
});

test('a held Task\'s responsible Run may only report work, ask, withdraw and record', () => {
  // An urgent comment is a record too.
  for (const action of [{ name: 'task.report', state: 'doing' }, { name: 'task.report', state: 'waiting' },
    { name: 'task.withdraw' }, { name: 'task.comment', urgent: false },
    { name: 'task.comment', urgent: true }] satisfies Action[])
    assert.ok(allowed(as('own', action, held)), JSON.stringify(action));
  for (const action of [{ name: 'task.report', state: 'done' }, { name: 'task.report', state: 'stopped' },
    { name: 'task.new', kind: 'task', userRequested: null }, { name: 'task.update', fields: ['values'] },
    { name: 'task.request', worker: true }, { name: 'agent.assign', worker: true },
    { name: 'agent.release', worker: true }] satisfies Action[]) {
    const refused = as('own', action, held);
    assert.ok(refused instanceof Problem && refused.code === 'forbidden', JSON.stringify(action));
  }
});

test('a Run whose own Task is held acts on none of its children: it does not instruct, stop or rearrange them', () => {
  for (const action of [{ name: 'task.request', worker: false }, { name: 'task.report', state: 'stopped' },
    { name: 'run.stop' }, { name: 'agent.assign', worker: false }, { name: 'agent.handover' },
    { name: 'agent.release', worker: false }, { name: 'task.update', fields: ['title'] },
    { name: 'task.update', fields: ['values'] }, { name: 'task.move', to: ['T5', 'T2', 'P1'] },
    { name: 'task.answer', askedTo: 'T2' }] satisfies Action[]) {
    assert.ok(allowed(as('parent', action, child())), `at work: ${JSON.stringify(action)}`);
    const refused = as('heldParent', action, child());
    assert.ok(refused instanceof Problem && refused.code === 'forbidden', `held: ${JSON.stringify(action)}`);
    assert.match(refused.message, /while its own Task is held/);
  }
  assert.ok(allowed(as('heldParent', { name: 'task.read' }, child())), 'it still reads');
});

test('the user\'s proxy confirms, holds and returns a review; the coordinator alone sets no state', () => {
  for (const state of ['doing', 'done'] as const)
    assert.ok(as('coordinator', { name: 'task.report', state }, child()) instanceof Problem, `coordinator ${state}`);
  for (const state of ['doing', 'done'] as const)
    assert.ok(as('human', { name: 'task.report', state }, child()) instanceof Problem,
      `a person does not set ${state} by hand either`);
  assert.ok(allowed(as('policy', { name: 'task.report', state: 'held' }, review)));
  assert.ok(allowed(as('utterance', { name: 'task.report', state: 'waiting' }, heldReview)));
  assert.ok(allowed(as('human', { name: 'task.report', state: 'done' }, heldReview)), 'a held review is confirmed as it is');
});

// Who writes, decided by the table rather than by each command.

test('a running owner Run records its placement as the report actor, and may write its values', () => {
  const report = as('own', { name: 'task.report', state: 'doing' }, child());
  assert.ok(allowed(report));
  assert.deepEqual(report.actor, { kind: 'placement', placementId: 'P3' });
  assert.ok(allowed(as('own', { name: 'task.update', fields: ['values'] }, child())));
});

test('a running owner Run can create only a child of its current Task', () => {
  const created = as('own', { name: 'task.new', kind: 'task', userRequested: null }, child());
  assert.ok(allowed(created));
  assert.deepEqual(created.actor, { kind: 'placement', placementId: 'P3' });
  for (const [task, kind] of [[null, 'project'], [project, 'task'], [child({ id: 'T4' }), 'task']] as const) {
    const refused = as('own', { name: 'task.new', kind, userRequested: null }, task);
    assert.ok(refused instanceof Problem && refused.code === 'forbidden', `${kind} below ${task?.id ?? 'nothing'}`);
  }
  assert.ok(as('own', { name: 'task.new', kind: 'project', userRequested: null }, child()) instanceof Problem,
    'a Run creates no project');
});

test('neither the parent nor the child itself accepts a child waiting for the user\'s review', () => {
  // Only the user's proxy confirms.
  const done: Action = { name: 'task.report', state: 'done', confirmation: true };
  assert.ok(as('parent', done, review) instanceof Problem);
  assert.ok(as('own', done, review) instanceof Problem, 'no self approval');
  assert.ok(allowed(as('parent', { name: 'task.request', worker: false }, review)), 'a parent may send an ordinary instruction');
  assert.ok(allowed(as('own', { name: 'task.report', state: 'done' }, review)), 'the owner may submit again without self-approval');
  const confirmed = as('human', done, review);
  assert.ok(allowed(confirmed));
  assert.deepEqual(confirmed.actor, { kind: 'human' });
  assert.ok(as('parent', { name: 'task.report', state: 'stopped' }, child({ parentId: 'T5' })) instanceof Problem,
    'a moved child\'s former parent controls it no more');
});

test('a Run for a worker or another Task cannot write the owner Task', () => {
  for (const who of ['worker', 'sibling', 'foreign'] as const)
    assert.ok(as(who, { name: 'task.report', state: 'doing' }, child()) instanceof Problem, who);
  const notResponsible: Caller = { kind: 'run', runId: 'R3', placementId: 'P3', taskId: 'T3', role: 'owner', responsible: false };
  for (const action of [{ name: 'task.report', state: 'doing' },
    { name: 'file.write' }] satisfies Action[])
    assert.ok(decide(notResponsible, action, { task: child(), runProject: 'P1', runState: 'doing', quote: null }) instanceof Problem,
      `an owner Run of a placement no longer responsible: ${action.name}`);
});

test('a Task file is written by a Run of its current placement or by a person, not by another Task\'s Run', () => {
  // The coordinator does no work, so it writes no file.
  assert.ok(allowed(as('own', { name: 'file.write' }, child())));
  assert.ok(allowed(as('worker', { name: 'file.write' }, child())));
  assert.ok(allowed(as('human', { name: 'file.write' }, child())));
  for (const who of ['sibling', 'parent', 'coordinator'] as const)
    assert.ok(as(who, { name: 'file.write' }, child()) instanceof Problem, who);
});

test('the screen\'s index and conversation, quiesce and administration are a person\'s', () => {
  // Configuration belongs to the user proxy; these screen and server operations remain human-only.
  for (const name of ['screen', 'coordinator.screen', 'runtime', 'admin'] as const) {
    assert.ok(allowed(as('human', { name }, null)), name);
    for (const who of ['own', 'worker', 'coordinator', 'utterance'] as const)
      assert.ok(as(who, { name }, null) instanceof Problem, `${name} as ${who}`);
  }
});

test('holding stays user-only; managers restore every base while own reports retain holds', () => {
  for (const state of ['todo', 'doing', 'error', 'waiting', 'held', 'done', 'stopped'] as const) {
    for (const who of Object.keys(CALLERS) as Who[]) {
      assert.equal(allowed(as(who, { name: 'task.report', state: 'held' }, child({ state }))),
        proxies.includes(who), `${who} holds ${state}`);
      if (state === 'held') continue;
      assert.equal(allowed(as(who, { name: 'task.report', state },
        child({ state: 'held', baseState: state }))), proxies.includes(who) || who === 'own' && (state === 'doing' || state === 'waiting') || who === 'parent',
        `${who} restores ${state}`);
    }
  }
});

test('holding a user-requested failure preserves the user-only retry and stop decision', () => {
  const task = child({ state: 'held', baseState: 'error', userRequested: true });
  for (const action of [{ name: 'task.request', worker: false }, { name: 'task.report', state: 'stopped' }] satisfies Action[]) {
    for (const who of Object.keys(CALLERS) as Who[])
      assert.equal(allowed(as(who, action, task)), proxies.includes(who), `${who} ${JSON.stringify(action)}`);
  }
});


test('an explicit review target remains a confirmation after reopening or approval and cannot self-approve', () => {
  const action: Action = { name: 'task.report', state: 'done', confirmation: true };
  for (const state of ['doing', 'done', 'waiting', 'held'] as const) {
    const task = child({ state});
    assert.ok(allowed(as('human', action, task)), state);
    assert.ok(allowed(as('utterance', action, task)), state);
    for (const who of ['own', 'parent', 'worker'] as const)
      assert.ok(as(who, action, task) instanceof Problem, `${state}/${who}`);
  }
});
