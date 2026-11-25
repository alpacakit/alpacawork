import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TaskLog } from '@alpacawork/raw/task-log-schema';
import type { RunConditions } from '@alpacawork/contract/run';
import { breakdown, changeMarks, segments, situationAt, type TraceRecords, type TraceRun, type TraceStep,
  type TraceTask } from '@alpacawork/backend/test-dist/analysis/timeline.js';
import { DEFAULT_THRESHOLDS, findFindings, thresholdsOf } from '@alpacawork/backend/test-dist/analysis/findings.js';
import { changeEvents } from '@alpacawork/backend/test-dist/analysis/changes.js';

const MIN = 60_000;
const epoch = Date.parse('2026-03-08T00:00:00Z');
const at = (minutes: number) => epoch + minutes * MIN;
const stamp = (minutes: number) => new Date(at(minutes)).toISOString();

function entry(id: string, kind: TaskLog['kind'], minutes: number, fields: Partial<TaskLog> = {}): TaskLog {
  return { id, kind, at: stamp(minutes), actor: { kind: 'human' }, fromState: null, toState: null, title: null, description: null, ...fields };
}
const state = (id: string, minutes: number, toState: NonNullable<TaskLog['toState']>) => entry(id, 'linked', minutes, { toState });
const asked = (id: string, minutes: number, decide: Record<string, unknown>[] = [{ decide_question: 'Which one?' }], askedTo: string | null = null) =>
  entry(id, 'asked', minutes, { askedTo, decide, actor: { kind: 'placement', placementId: 'seat' }, description: 'A question' });
const answered = (id: string, minutes: number, question: string) => entry(id, 'answered', minutes, { questionId: question });

function task(id: string, log: TaskLog[], parent: string | null = null): TraceTask {
  return { id, parent, title: `Task ${id}`, created: at(0), log };
}
function run(id: string, fields: Partial<TraceRun> & { task?: string }): TraceRun {
  return { id, task: 'T1', placement: 'owner-seat', role: 'owner', agent: 'claude', model: 'opus', effort: 'medium', state: 'succeeded',
    reason: null, request: `request-${id}`, supersededBy: null, created: at(0), started: at(0), ended: at(10), compactions: [],
    steps: [], stepsMissing: null, conditions: null, stopped: [], ...fields };
}
function step(n: number, from: number, to: number | null, fields: Partial<TraceStep> = {}): TraceStep {
  return { n, id: `call-${n}`, tool: 'Bash', kind: 'command', line: 'pnpm test', fingerprint: 'pnpm test', from: at(from),
    to: to === null ? null : at(to), state: 'done', source: 'reported', inside: null, subagentSteps: 0, output: `out-${n}`, ...fields };
}
function records(tasks: TraceTask[], runs: TraceRun[], now = at(200)): TraceRecords {
  return { root: tasks[0]!.id, project: 'P1', scope: tasks.length > 1 ? 'subtree' : 'self', tasks, runs, requests: new Map(),
    labels: new Map(), family: new Set(tasks.map(item => item.id)), activity: [], now };
}
const window = (from: number, to: number) => ({ from: at(from), to: at(to) });
const find = (data: TraceRecords, rule: Parameters<typeof findFindings>[2][number], to = 200, thresholds = DEFAULT_THRESHOLDS) =>
  findFindings(data, window(0, to), [rule], thresholds);

test('the breakdown gives each instant to the first part that holds, and the parts sum to the wall time', () => {
  const root = task('T1', [state('s1', 0, 'doing'), asked('q1', 60), answered('a1', 90, 'q1'), state('s2', 100, 'held'),
    state('s3', 110, 'waiting'), state('s4', 150, 'done')]);
  const child = task('T2', [asked('q2', 40, undefined, 'T1'), answered('a2', 50, 'q2')], 'T1');
  const data = records([root, child], [
    run('R1', { started: at(0), ended: at(20) }),
    run('R2', { placement: 'member-seat', role: 'member', started: at(10), ended: at(30) }),
    run('R3', { task: 'T2', placement: 'child-seat', started: at(25), ended: at(40) }),
    run('R4', { created: at(120), started: at(130), ended: at(135) }),
  ]);
  const result = breakdown(data, window(0, 160), segments(data, window(0, 160)));
  const parts = Object.fromEntries(result.categories.map(part => [part.key, part.ms / MIN]));
  assert.deepEqual(parts, { 'owner-working': 25, 'member-working': 10, 'child-working': 10, held: 10,
    'waiting-answer': 40, 'waiting-review': 35, queued: 0, idle: 30 });
  assert.equal(result.categories.reduce((sum, part) => sum + part.ms, 0), result.wall);
  assert.deepEqual(result.answerTo, { user: 30 * MIN, task: 10 * MIN });
  // R1, R2 and R3 overlap: busy counts the overlap once, work counts each Run.
  assert.equal(result.aiBusyMs, 45 * MIN);
  assert.equal(result.aiWorkMs, 60 * MIN);
});

test('step-level values are null while a Run has no step times, and count parallel steps once', () => {
  const root = task('T1', [state('s1', 0, 'doing')]);
  const timed = run('R1', { started: at(0), ended: at(20), steps: [step(0, 2, 8), step(1, 4, 10), step(2, 5, 6, { inside: 'call-1' })] });
  const known = records([root], [timed]);
  const result = breakdown(known, window(0, 20), segments(known, window(0, 20)));
  assert.deepEqual([result.toolMs, result.thinkingMs, result.stepWorkMs], [8 * MIN, 12 * MIN, 12 * MIN]);
  const unknown = records([root], [timed, run('R2', { started: at(5), ended: at(15), steps: null, stepsMissing: 'before-journal' })]);
  const partial = breakdown(unknown, window(0, 20), segments(unknown, window(0, 20)));
  assert.deepEqual([partial.toolMs, partial.thinkingMs, partial.stepWorkMs], [null, null, null]);
  assert.equal(partial.categories.find(part => part.key === 'owner-working')!.ms, 20 * MIN);
});

test('long-wait counts only the time a question waited with no AI running', () => {
  const root = task('T1', [state('s1', 0, 'doing'), asked('q1', 10), answered('a1', 70, 'q1'), asked('q2', 80), answered('a2', 100, 'q2')]);
  const data = records([root], [run('R1', { started: at(0), ended: at(30) })]);
  const found = find(data, 'long-wait');
  assert.deepEqual(found.map(item => [item.anchor, item.durationMs / MIN]), [['q1', 40]]);
});

test('repeated-question joins questions naming the same pull request, whatever their wording', () => {
  const pr = (text: string, choices: string[]) => [{ decide_question: text, decide_choices: choices.map(choice => ({ decide_choice: choice })) }];
  const root = task('T1', [state('s1', 0, 'doing'),
    asked('q1', 10, pr('Merge PR #7?', ['Merge now', 'Fix first'])), answered('a1', 20, 'q1'),
    asked('q2', 30, pr('Merge the fixed PR #7 and PR #8?', ['Merge', 'Hold'])), answered('a2', 40, 'q2'),
    asked('q3', 50, pr('Merge https://github.com/example/app/pull/8 now?', ['Yes', 'No'])), answered('a3', 55, 'q3'),
    asked('q4', 60, pr('Which layout?', ['A', 'B'])), answered('a4', 65, 'q4')]);
  const found = find(records([root], []), 'repeated-question');
  assert.deepEqual(found.map(item => [item.count, item.evidence.length, item.durationMs / MIN]), [[3, 3, 25]]);
  assert.equal(find(records([root], []), 'repeated-question', 200, thresholdsOf(['repeated-question=4'])).length, 0);
});

test('long-step finds a long step or one far beyond its usual time, judging a sub-agent by its own steps', () => {
  const short = (n: number, from: number) => step(n, from, from + 0.5, { fingerprint: 'pnpm build' });
  const data = records([task('T1', [])], [run('R1', { started: at(0), ended: at(60), steps: [
    short(0, 0), short(1, 1), short(2, 2), step(3, 3, 5, { fingerprint: 'pnpm build' }),
    step(4, 10, 20, { tool: 'Task', subagentSteps: 2 }), step(5, 10, 16, { inside: 'call-4', fingerprint: 'sleep' }), step(6, 16, 17, { inside: 'call-4' }),
  ] })]);
  assert.deepEqual(find(data, 'long-step').map(item => item.anchor).sort(), ['R1.3', 'R1.5']);
});

test('limit-hit names each command stopped at the limit and the step it stopped', () => {
  const data = records([task('T1', [])], [run('R1', { started: at(0), ended: at(30), steps: [step(0, 5, 15)],
    stopped: [{ at: at(15), seconds: 600, signal: 'SIGTERM' }] })]);
  const [found] = find(data, 'limit-hit');
  assert.deepEqual([found!.durationMs, found!.evidence], [600_000, [{ run: 'R1', step: 0 }]]);
});

test('repeated-command finds the same command with the same result, not one repeated after an edit', () => {
  const same = (n: number) => step(n, n, n + 0.5, { output: 'same' });
  const unchanged = run('R1', { steps: [same(0), same(1), step(2, 1.6, 1.7, { kind: 'file', fingerprint: 'cat x' }), same(3)] });
  assert.deepEqual(find(records([task('T1', [])], [unchanged]), 'repeated-command').map(item => item.count), [3]);
  const edited = run('R1', { steps: [same(0), same(1), step(2, 1.6, 1.7, { kind: 'edit', fingerprint: 'edit x' }), same(3)] });
  assert.equal(find(records([task('T1', [])], [edited]), 'repeated-command').length, 0);
  const failing = run('R1', { steps: [0, 1, 2].flatMap(n => [step(n * 2, n, n + 0.5, { state: 'failed', output: `fail-${n}` }),
    step(n * 2 + 1, n + 0.6, n + 0.7, { kind: 'edit', fingerprint: 'edit x' })]) });
  assert.deepEqual(find(records([task('T1', [])], [failing]), 'repeated-command').map(item => item.count), [3]);
});

test('queue-wait finds a Run that waited long in the queue', () => {
  const data = records([task('T1', [])], [run('R1', { created: at(0), started: at(1) }), run('R2', { created: at(10), started: at(20), ended: at(25) })]);
  assert.deepEqual(find(data, 'queue-wait').map(item => [item.anchor, item.durationMs / MIN]), [['R2', 10]]);
});

test('failed-run names a failed or stopped Run and the Run that took its place', () => {
  const data = records([task('T1', [])], [run('R1', { state: 'failed', reason: 'exit', supersededBy: 'R2' }), run('R2', {}),
    run('R3', { state: 'cancelled', reason: 'stopped' })]);
  assert.deepEqual(find(data, 'failed-run').map(item => item.evidence), [[{ run: 'R1' }, { run: 'R2' }], [{ run: 'R3' }]]);
});

test('rework finds a send-back and an instruction at review or after done, timed to the next result', () => {
  const root = task('T1', [state('s1', 0, 'doing'), entry('i0', 'request_accepted', 5, { fromState: 'doing' }),
    state('s2', 10, 'waiting'), entry('back', 'review_sent_back', 20, { fromState: 'waiting' }), state('s3', 21, 'doing'),
    state('s4', 40, 'waiting'), state('s5', 50, 'done'), entry('again', 'request_accepted', 60, { fromState: 'done' }),
    entry('answer', 'request_accepted', 61, { fromState: 'done', answers: 'q' }), state('s6', 61, 'doing'), state('s7', 90, 'done')]);
  assert.deepEqual(find(records([root], []), 'rework').map(item => [item.anchor, item.durationMs / MIN]), [['again', 30], ['back', 20]]);
});

test('idle finds a long stretch with nothing running, queued, asked or in review', () => {
  const root = task('T1', [state('s1', 0, 'doing')]);
  const data = records([root], [run('R1', { started: at(0), ended: at(10) }), run('R2', { created: at(20), started: at(20), ended: at(30) }),
    run('R3', { created: at(60), started: at(60), ended: at(70) })]);
  assert.deepEqual(find(data, 'idle', 70).map(item => [stamp((item.at - epoch) / MIN), item.durationMs / MIN]), [[stamp(30), 30]]);
});

test('change marks compare each Run with the one before it on the same seat', () => {
  const conditions = (skill: string, version = '1.0.0'): RunConditions => ({ v: 1, observedAt: stamp(0), version, release: null, source: null,
    cwd: { path: '/work', commit: null }, instructions: [{ path: '/home/.claude/CLAUDE.md', digest: 'aaaaaaaaaaaaaaaa' }],
    skills: [{ scope: 'personal', folder: '/home/skills', items: [{ name: 'review', digest: skill }] }] });
  const data = records([task('T1', [])], [
    run('R1', { started: at(0), conditions: conditions('1111111111111111') }),
    run('R2', { started: at(20), conditions: conditions('2222222222222222'), model: 'sonnet' }),
    run('R3', { started: at(30), placement: 'member-seat', role: 'member', model: 'haiku', conditions: conditions('1111111111111111', '2.0.0') }),
    run('R4', { started: at(40), conditions: conditions('2222222222222222'), model: 'sonnet' }),
  ]);
  const marks = changeMarks(data);
  assert.deepEqual(marks.map(mark => mark.kind === 'change' && [mark.run, mark.previous, mark.changes.map(change => [change.what, change.name, change.to])]),
    [['R2', 'R1', [['model', null, 'sonnet'], ['skill', 'personal:review', '2222222222222222']]]]);
});

test('at an instant: states, the Run running with its steps around that time, the queue and the open questions', () => {
  const root = task('T1', [state('s1', 0, 'doing'), asked('q1', 5)]);
  const data = records([root], [
    run('R1', { started: at(0), ended: at(30), steps: [step(0, 1, 4), step(1, 6, 12), step(2, 7, 8, { inside: 'call-1', tool: 'Read' }), step(3, 14, 15)] }),
    run('R2', { created: at(5), started: at(31), ended: at(40) }),
  ]);
  const situation = situationAt(data, at(7.5));
  assert.deepEqual(situation.tasks.map(item => item.state), ['doing']);
  const [running] = situation.runs;
  assert.deepEqual([running!.run, running!.current.map(item => item.step), running!.before?.step, running!.after?.step], ['R1', [1, 2], 0, 3]);
  assert.deepEqual(situation.queued.map(item => item.run), ['R2']);
  assert.deepEqual(situation.questions.map(item => [item.question, item.askedTo, item.accept, item.estimated]), [['q1', 'user', false, true]]);
  assert.equal(situation.values, null);
});

test('a question asking to take a result is review time, and the waits split by where the user was', () => {
  const accept = [{ decide_question: 'Take the result?', decide_kind: 'accept', decide_choices: [{ decide_choice: 'Take' }] }];
  const root = task('T1', [state('s1', 0, 'doing'), asked('q1', 10, accept), answered('a1', 100, 'q1'), asked('q2', 100), answered('a2', 120, 'q2')]);
  // The user acts on another task at 5 and 20, then nothing until 80 (away), then on this task at 90 and 110; it is now 125.
  const data = { ...records([root], [], at(125)), activity: [{ at: at(5), task: 'T9' }, { at: at(20), task: 'T9' }, { at: at(80), task: 'T1' },
    { at: at(90), task: 'T1' }, { at: at(110), task: 'T1' }] };
  const { settled, ...result } = breakdown(data, window(0, 120), segments(data, window(0, 120)));
  // The last part follows the last action by less than 30 minutes: it still depends on when it is read.
  assert.equal(settled, false);
  const part = (key: string) => result.categories.find(item => item.key === key)!.ms / MIN;
  assert.deepEqual([part('waiting-review'), part('waiting-answer')], [90, 20]);
  assert.deepEqual({ away: result.waits.away / MIN, otherTasks: result.waits.otherTasks / MIN, thisTask: result.waits.thisTask / MIN },
    { away: 60, otherTasks: 10, thisTask: 40 });
  assert.equal(result.waits.away + result.waits.otherTasks + result.waits.thisTask, (part('waiting-review') + part('waiting-answer')) * MIN);
});

test('rework includes an instruction given in place of answering a question asking to take a result', () => {
  const accept = [{ decide_question: 'Merge it?', decide_kind: 'accept' }];
  const choose = [{ decide_question: 'Which layout?', decide_kind: 'choose' }];
  const root = task('T1', [state('s1', 0, 'doing'), asked('q1', 10, accept), entry('fix', 'request_accepted', 20, { fromState: 'doing' }),
    entry('w1', 'question_withdrawn', 20, { questionId: 'q1', originCauseId: 'fix' }), asked('q2', 30, choose),
    entry('more', 'request_accepted', 40, { fromState: 'doing' }), entry('w2', 'question_withdrawn', 40, { questionId: 'q2', originCauseId: 'more' }),
    state('s2', 50, 'waiting')]);
  assert.deepEqual(find(records([root], []), 'rework').map(item => [item.anchor, item.evidence.length]), [['fix', 2]]);
});

test('scope-wide changes compare an agent\'s conditions across its seats, and launch choices within each seat', () => {
  const conditions = (skills: Record<string, string>, version = '1.0.0'): RunConditions => ({ v: 1, observedAt: stamp(0), version, release: null,
    source: null, cwd: { path: '/work', commit: null }, instructions: [],
    skills: [{ scope: 'personal', folder: '/home/skills', items: Object.entries(skills).map(([name, digest]) => ({ name, digest })) }] });
  const runs = [
    run('R1', { started: at(0), placement: 'owner', model: 'opus', conditions: conditions({ review: '1111111111111111', plan: '3333333333333333' }) }),
    run('R2', { started: at(10), placement: 'member', model: 'sonnet', conditions: conditions({ review: '1111111111111111', plan: '3333333333333333' }) }),
    run('R3', { started: at(20), placement: 'member', model: 'sonnet', conditions: conditions({ review: '2222222222222222' }, '1.1.0') }),
    run('R4', { started: at(30), placement: 'owner', model: 'sonnet', conditions: conditions({ review: '2222222222222222' }, '1.1.0') }),
  ];
  const events = changeEvents(runs, (item, what) => ['agent', 'model', 'effort'].includes(what) ? item.placement : item.agent);
  assert.deepEqual(events.map(event => [event.run.id, event.changes.map(change => [change.what, change.name, change.to])]), [
    ['R3', [['version', null, '1.1.0'], ['skill', 'personal:plan', null], ['skill', 'personal:review', '2222222222222222']]],
    ['R4', [['model', null, 'sonnet']]],
  ]);
});
