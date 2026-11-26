import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TaskLog } from '@alpacawork/raw/task-log-schema';
import type { RunConditions } from '@alpacawork/contract/run';
import { breakdown, changeMarks, segments, situationAt, thinkingIntervals, timedSteps, waited, type TraceRecords, type TraceRun,
  type TraceStep, type TraceTask } from '@alpacawork/backend/test-dist/analysis/timeline.js';
import { lastEndedAt, taskOutcome, userQuestions } from '@alpacawork/backend/test-dist/analysis/rules.js';
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
    to: to === null ? null : at(to), state: 'done', source: 'reported', inside: null, subagentSteps: 0, output: `out-${n}`, more: 0, ...fields };
}
function records(tasks: TraceTask[], runs: TraceRun[], now = at(200)): TraceRecords {
  return { root: tasks[0]!.id, project: 'P1', scope: tasks.length > 1 ? 'subtree' : 'self', tasks, runs, requests: new Map(),
    labels: new Map(), rootState: 'doing', activity: [], version: 'test', now };
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

test('repeated-question joins questions on the same pull request or the same choices, and nothing else', () => {
  const ask = (text: string, choices: string[] = []) => [{ decide_question: text, decide_choices: choices.map(choice => ({ decide_choice: choice })) }];
  const root = task('T1', [state('s1', 0, 'doing'),
    asked('q1', 10, ask('Merge PR #7?', ['Merge now', 'Fix first'])), answered('a1', 20, 'q1'),
    asked('q2', 30, ask('Merge the fixed PR #7 and PR #8?', ['Merge', 'Hold'])), answered('a2', 40, 'q2'),
    asked('q3', 50, ask('Merge PR #8 now?', ['Yes', 'No'])), answered('a3', 55, 'q3'),
    // The same number in two repositories, and questions offering no choices, are separate questions.
    // A link names the repository, so the bare `PR #5` beside it joins nothing.
    ...['one', 'two', 'three'].flatMap((repo, n) => [asked(`r${n}`, 60 + n, ask(`Merge PR #5 (https://github.com/example/${repo}/pull/5)?`)),
      answered(`ra${n}`, 61 + n, `r${n}`)]),
    ...[0, 1, 2].flatMap(n => [asked(`free${n}`, 70 + n, ask(`Anything else ${n}?`)), answered(`fa${n}`, 71 + n, `free${n}`)])]);
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

test('repeated-failure is the same failure again and again; the same success again is same-result', () => {
  const findIn = (rule: 'repeated-failure' | 'same-result', steps: TraceStep[]) =>
    find(records([task('T1', [])], [run('R1', { steps })]), rule).map(item => item.count);
  // Three identical `git status` that succeed: one same-result, no repeated-failure.
  const status = [0, 1, 2].map(n => step(n, n, n + 0.5, { fingerprint: 'git status', line: 'git status', output: 'clean' }));
  assert.deepEqual([findIn('repeated-failure', status), findIn('same-result', status)], [[], [3]]);
  // A status check whose output changes each time is no finding.
  const changing = [0, 1, 2, 3].map(n => step(n, n, n + 0.5));
  assert.deepEqual([findIn('repeated-failure', changing), findIn('same-result', changing)], [[], []]);
  const failing = (output: (n: number) => string) => [0, 1, 2].flatMap(n => [step(n * 2, n, n + 0.5, { state: 'failed', output: output(n) }),
    step(n * 2 + 1, n + 0.6, n + 0.7, { kind: 'edit', fingerprint: 'edit x' })]);
  assert.deepEqual(findIn('repeated-failure', failing(() => 'fail')), [3]);
  assert.deepEqual(findIn('repeated-failure', failing(n => `fail-${n}`)), []);
  // A success between failures ends the row.
  const broken = [step(0, 0, 0.5, { state: 'failed', output: 'fail' }), step(1, 1, 1.5, { state: 'failed', output: 'fail' }),
    step(2, 2, 2.5), step(3, 3, 3.5, { state: 'failed', output: 'fail' })];
  assert.deepEqual(findIn('repeated-failure', broken), []);
});

test('same-result breaks at any write and counts only known successes with their whole output', () => {
  const get = (n: number, fields: Partial<TraceStep> = {}) => step(n, n, n + 0.1, { fingerprint: 'alpacawork task get --task <id>',
    line: 'alpacawork task get --task T1', output: 'same', ...fields });
  const count = (steps: TraceStep[]) => find(records([task('T1', [])], [run('R1', { steps })]), 'same-result').map(item => item.count);
  const shell = (n: number, line: string, more = 0) => step(n, n, n + 0.1, { fingerprint: line, line, output: `w-${n}`, more });
  // A shell command that writes splits the reads as an edit does; one that only reads does not.
  assert.deepEqual(count([get(0), shell(1, 'printf changed > ./synthetic-file'), get(2)]), []);
  for (const line of ['echo x >> notes.md', 'sed -i s/a/b/ file', 'git commit -m change', 'rm -f out', 'cat a | tee b', 'node -e "write()"',
    'printf changed >& ./synthetic-file', 'git -C ./other-repo commit -m example', 'make &> build.log'])
    assert.deepEqual(count([get(0), shell(1, line), get(2)]), [], line);
  // A script whose body is not read here may write: it splits too.
  assert.deepEqual(count([get(0), shell(1, 'python3 - <<EOF', 4), get(2)]), []);
  assert.deepEqual(count([get(0), shell(1, 'git status 2>&1'), shell(2, 'ls > /dev/null'), shell(3, 'git -C ./repo status 2>&-'), get(4)]), [2]);
  // Unknown state or a cut output (no whole digest) never joins.
  assert.deepEqual(count([get(0, { state: 'unknown' }), get(1, { state: 'unknown' })]), []);
  assert.deepEqual(count([get(0, { output: null }), get(1, { output: null }), get(2)]), []);
  const failing = [0, 1, 2].map(n => step(n, n, n + 0.5, { state: 'failed', output: null }));
  assert.equal(find(records([task('T1', [])], [run('R1', { steps: failing })]), 'repeated-failure').length, 0);
});

test('same-result finds a read repeated with the same answer, and fan-out one fingerprint read one by one', () => {
  const read = (n: number, line: string, output: string, kind = 'file') => step(n, n, n + 0.1, { kind, fingerprint: 'task get <id>', line, output });
  // A shell command re-reading the same answer (design: `task get` with the same arguments) is a read as well.
  const sameResult = find(records([task('T1', [])], [run('R1', { steps: [read(0, 'a', 'x', 'command'), read(1, 'a', 'x', 'command'),
    read(2, 'b', 'y')] })]), 'same-result');
  assert.deepEqual(sameResult.map(item => [item.count, item.evidence]), [[2, [{ run: 'R1', step: 0 }, { run: 'R1', step: 1 }]]]);
  const edited = [read(0, 'a', 'x'), step(1, 1, 1.1, { kind: 'edit', fingerprint: 'edit' }), read(2, 'a', 'x')];
  assert.equal(find(records([task('T1', [])], [run('R1', { steps: edited })]), 'same-result').length, 0);
  const many = Array.from({ length: 25 }, (_, n) => read(n, `task get T${n}`, `out-${n}`, 'command'));
  const fanOut = find(records([task('T1', [])], [run('R1', { steps: many })]), 'fan-out');
  assert.deepEqual(fanOut.map(item => [item.count, item.evidence.length]), [[25, 10]]);
  assert.equal(find(records([task('T1', [])], [run('R1', { steps: many.slice(0, 19) })]), 'fan-out').length, 0);
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

test('rework is what the counts count: send-backs, instructions at review and after acceptance, also after a reopen', () => {
  const accepted = (id: string, minutes: number) => entry(id, 'review_approved', minutes, { fromState: 'waiting', toState: 'done' });
  const root = task('T1', [entry('i0', 'request_accepted', 0, { fromState: 'todo' }), state('s1', 1, 'doing'),
    state('s2', 10, 'waiting'), entry('back', 'review_sent_back', 20, { fromState: 'waiting' }), state('s3', 21, 'doing'),
    entry('during', 'request_accepted', 25, { fromState: 'doing' }), state('s4', 40, 'waiting'), accepted('ok', 50),
    // Reopened after acceptance: an instruction while working again is rework after acceptance.
    state('s5', 60, 'doing'), entry('again', 'request_accepted', 70, { fromState: 'doing' }), state('s6', 90, 'waiting')]);
  const outcome = taskOutcome(root.log, 'waiting', stamp(0), userQuestions(root.log));
  const counted = outcome.instructions.sendBacks + outcome.instructions.instructionsAtReview + outcome.instructions.instructionsAfterAccept;
  const found = find({ ...records([root], []), rootState: 'waiting' }, 'rework');
  assert.equal(found.length, counted);
  assert.deepEqual(found.map(item => [item.anchor, item.durationMs / MIN]), [['back', 20], ['again', 20]]);
});

test('a task reopened after it ended waits again from its latest end', () => {
  const accepted = (id: string, minutes: number) => entry(id, 'review_approved', minutes, { fromState: 'waiting', toState: 'done' });
  const log = [state('s1', 0, 'doing'), state('s2', 5, 'waiting'), accepted('first', 10), state('s3', 20, 'doing'),
    state('s4', 25, 'waiting'), accepted('second', 30), state('s5', 40, 'doing'), state('s6', 45, 'waiting')];
  assert.equal(lastEndedAt(log, at(50)), at(30));
  assert.equal(lastEndedAt(log, at(15)), at(10));
  assert.equal(lastEndedAt([state('s1', 0, 'doing')], at(50)), null);
});

test('a Run whose output has steps without times has unknown step time, and thinking is the time no step ran', () => {
  assert.equal(timedSteps([step(0, 1, 2), step(1, 3, 4, { from: null })]), null);
  // A step the output shows as ended without its end time is unknown too; only a running step has no end.
  assert.equal(timedSteps([step(0, 1, null, { state: 'done' })]), null);
  assert.equal(timedSteps([step(0, 1, null, { state: 'running' })])?.length, 1);
  const timed = run('R1', { started: at(0), ended: at(20), steps: [step(0, 2, 8), step(1, 4, 10), step(2, 12, 15)] });
  assert.deepEqual(thinkingIntervals(timed, at(30)).map(gap => [(gap.from - epoch) / MIN, (gap.to - epoch) / MIN]), [[0, 2], [10, 12], [15, 20]]);
  assert.deepEqual(thinkingIntervals({ ...timed, steps: null }, at(30)), []);
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
  // Steps run in parallel: the one before is the one that ended last, not the one that started last.
  const parallel = records([root], [run('R1', { started: at(0), ended: at(30), steps: [step(0, 1, 6), step(1, 2, 5)] })]);
  assert.equal(situationAt(parallel, at(7)).runs[0]!.before?.step, 0);
});

test('a question asking to take a result is review time, and the waits split by where the user was', () => {
  const accept = [{ decide_question: 'Take the result?', decide_kind: 'accept', decide_choices: [{ decide_choice: 'Take' }] }];
  const root = task('T1', [state('s1', 0, 'doing'), asked('q1', 10, accept), answered('a1', 100, 'q1'), asked('q2', 100), answered('a2', 120, 'q2')]);
  // The user acts on another task at 5 and 20, then nothing until 80 (away), then on this task at 90 and 110; it is now 125.
  const data = { ...records([root], [], at(125)), activity: [{ at: at(5), task: 'T9' }, { at: at(20), task: 'T9' }, { at: at(80), task: 'T1' },
    { at: at(90), task: 'T1' }, { at: at(110), task: 'T1' }] };
  const result = breakdown(data, window(0, 120), segments(data, window(0, 120)));
  const part = (key: string) => result.categories.find(item => item.key === key)!.ms / MIN;
  assert.deepEqual([part('waiting-review'), part('waiting-answer')], [90, 20]);
  const { time, waits, settled } = waited(data, window(0, 120));
  assert.deepEqual([time.review / MIN, time.answer / MIN], [90, 20]);
  assert.deepEqual({ away: waits.away / MIN, otherTasks: waits.otherTasks / MIN, thisTask: waits.thisTask / MIN }, { away: 60, otherTasks: 10, thisTask: 40 });
  // The last part follows the last action by less than 30 minutes: it still depends on when it is read.
  assert.equal(settled, false);
});

test('rework includes an instruction given in place of answering a question asking to take a result', () => {
  const accept = [{ decide_question: 'Merge it?', decide_kind: 'accept' }];
  const choose = [{ decide_question: 'Which layout?', decide_kind: 'choose' }];
  const root = task('T1', [entry('i0', 'request_accepted', 0, { fromState: 'todo' }), state('s1', 0, 'doing'), asked('q1', 10, accept),
    entry('fix', 'request_accepted', 20, { fromState: 'doing' }),
    entry('w1', 'question_withdrawn', 20, { questionId: 'q1', originCauseId: 'fix' }), asked('q2', 30, choose),
    entry('more', 'request_accepted', 40, { fromState: 'doing' }), entry('w2', 'question_withdrawn', 40, { questionId: 'q2', originCauseId: 'more' }),
    state('s2', 50, 'waiting')]);
  assert.deepEqual(find(records([root], []), 'rework').map(item => [item.anchor, item.evidence.length]), [['fix', 2]]);
  // The redone work ends where a result is next put to the user, a question asking to take it included.
  const again = asked('q3', 45, accept), last = root.log.at(-1)!;
  const asking = task('T1', [...root.log.slice(0, -1), again, last]);
  const [found] = find(records([asking], []), 'rework');
  assert.equal(found!.durationMs, Date.parse(again.at) - found!.at);
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

test('an item added to a recorded set is a change, as a removal is; the first conditions recorded are not', () => {
  const conditions = (files: string[]): RunConditions => ({ v: 1, observedAt: stamp(0), version: '1.0.0', release: null, source: null,
    cwd: { path: '/work', commit: null }, skills: [], instructions: files.map(path => ({ path, digest: 'aaaaaaaaaaaaaaaa' })) });
  const runs = [run('R1', { started: at(0), conditions: conditions([]) }), run('R2', { started: at(10), conditions: conditions(['/home/AGENTS.md']) }),
    run('R3', { started: at(20), conditions: conditions([]) }), run('R4', { started: at(30), conditions: conditions(['/home/AGENTS.md']) })];
  const events = changeEvents(runs, item => item.placement);
  assert.deepEqual(events.map(event => [event.run.id, event.changes.map(change => [change.what, change.from, change.to])]), [
    ['R2', [['instruction-file', null, 'aaaaaaaaaaaaaaaa']]], ['R3', [['instruction-file', 'aaaaaaaaaaaaaaaa', null]]],
    ['R4', [['instruction-file', null, 'aaaaaaaaaaaaaaaa']]]]);
  assert.deepEqual(changeEvents([run('R1', { started: at(0) }), run('R2', { started: at(10), conditions: conditions(['/home/AGENTS.md']) })],
    item => item.placement), []);
});
