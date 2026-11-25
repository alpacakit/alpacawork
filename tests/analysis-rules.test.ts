import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TaskLog } from '@alpacawork/raw/task-log-schema';
import { analysisListInput, analysisTasksInput, analysisUsageInput } from '@alpacawork/contract/analysis';
import { buckets, calendar, makeHead } from '@alpacawork/backend/test-dist/analysis/calendar.js';
import { clocks, firstConversations, launchOf, prLinks, shareOf, taskOutcome, userQuestions,
  type RunEvidence } from '@alpacawork/backend/test-dist/analysis/rules.js';
import { runUsageMs } from '@alpacawork/contract';
import { TallyParser } from '@alpacawork/backend/test-dist/agents/adapters/tally.js';
import { warmAnalysisWhenIdle } from '@alpacawork/backend/test-dist/analysis/reads.js';
import { splitWaits } from '@alpacawork/backend/test-dist/analysis/presence.js';
import { CluesSum } from '@alpacawork/backend/test-dist/analysis/clues.js';

const epoch = Date.parse('2026-03-08T05:00:00Z');
const stamp = (offset: number) => new Date(epoch + offset).toISOString();
function event(id: string, kind: TaskLog['kind'], offset: number, fields: Partial<TaskLog> = {}): TaskLog {
  return { id, kind, at: stamp(offset), actor: { kind: 'human' }, fromState: null, toState: null,
    title: null, description: null, ...fields };
}

test('first acceptance retains the unit and each kind of rework is based on committed records', () => {
  const created = event('created', 'created', 0, { toState: 'todo', userRequested: true });
  const first = event('first', 'request_accepted', 10, { fromState: 'todo' });
  const submit = event('submit', 'reported', 100, { fromState: 'doing', toState: 'waiting' });
  const accepted = event('accepted', 'review_approved', 200, { fromState: 'waiting', toState: 'done' });
  const during = event('during', 'request_accepted', 50, { fromState: 'doing' });
  const lateAnswer = event('later-answer', 'request_accepted', 300, { fromState: 'done', answers: 'question' });
  const backFromHold = event('unhold', 'reported', 150, { fromState: 'held', toState: 'waiting' });
  const base = [created, first, during, submit, backFromHold, accepted, lateAnswer];
  const facts = (log: TaskLog[]) => taskOutcome(log, 'doing', created.at);
  assert.deepEqual([facts(base).passed, facts(base).submits, facts(base).leadMs], [true, 1, 190]);
  assert.equal(facts([...base, event('later', 'request_accepted', 301, { fromState: 'done' })]).passed, false);
  assert.equal(facts([...base, event('send-back', 'review_sent_back', 302)]).passed, false);
  assert.equal(facts([created, first, submit, event('send-back', 'review_sent_back', 101), accepted]).passed, false);
  assert.equal(facts([created, first, submit, { ...submit, id: 'submit-again', at: stamp(160) }, accepted]).passed, false);
  const update = event('update', 'request_accepted', 160, { fromState: 'doing' });
  const linked = event('link', 'linked', 161, { originCauseId: update.id, fromState: 'waiting', toState: 'doing' });
  const later = event('later-link', 'linked', 170, { originCauseId: update.id, fromState: 'doing', toState: 'error' });
  assert.equal(facts([created, first, submit, update, linked, later, accepted]).passed, false);
  const workUpdate = { ...update, at: stamp(90) };
  const workHistory = facts([created, first, workUpdate, submit, linked, accepted]);
  assert.equal(workHistory.passed, true);
  assert.equal(workHistory.instructions.instructionsDuringWork, 1);
  assert.equal(facts([created, first, submit, { ...linked, at: stamp(159) }, update, accepted]).passed, true);
  assert.equal(facts([created, first, submit, update, { ...linked, originCauseId: 'other' }, accepted]).passed, true);
  const held = event('during-hold', 'request_accepted', 80, { fromState: 'held' });
  const after = event('after', 'request_accepted', 310, { fromState: 'doing' });
  const sendBack = event('send-back', 'review_sent_back', 190);
  assert.deepEqual(facts([created, first, during, held, submit, update, linked, sendBack, accepted, lateAnswer, after]).instructions,
    { sendBacks: 1, instructionsAtReview: 1, instructionsAfterAccept: 1, instructionsDuringWork: 2 });
  const manual = event('manual', 'reported', 210, { fromState: 'doing', toState: 'done' });
  assert.equal(facts([created, manual]).acceptedAt, manual.at);
  assert.equal(facts([...base, manual]).acceptedAt, accepted.at);
});

test('a state-preserving link during review does not turn the initial instruction into rework', () => {
  const initial = event('initial', 'request_accepted', 0, { fromState: 'todo',
    actor: { kind: 'main', provider: 'codex', conversationId: 'synthetic' } });
  const submit = event('submit', 'reported', 10, { fromState: 'doing', toState: 'waiting' });
  const boundary = event('boundary', 'linked', 20, { originCauseId: initial.id, fromState: 'waiting', toState: null });
  const accepted = event('accepted', 'review_approved', 30, { fromState: 'waiting', toState: 'done' });
  assert.equal(taskOutcome([initial, submit, boundary, accepted], 'done', initial.at).passed, true);
});

test('stop uses the last real transition and the recorded cause at the local day boundary', () => {
  const created = event('create', 'created', 0, { toState: 'todo', userRequested: true });
  const stop = event('stop', 'reported', 10, { fromState: 'todo', toState: 'stopped' });
  const restart = event('restart', 'linked', 15, { fromState: 'stopped', toState: 'doing' });
  const propagated = event('propagated', 'linked', 21, { fromState: 'doing', toState: 'stopped', causeAt: stamp(19) });
  propagated.causeAt = '2026-03-08T00:00:00.019-05:00';
  const repeat = event('repeat', 'reported', 22, { fromState: 'stopped', toState: 'stopped' });
  assert.equal(taskOutcome([created, stop, restart], 'doing', created.at).finishedAt, null);
  assert.equal(taskOutcome([created, stop, restart, propagated, repeat], 'stopped', created.at).finishedAt, stamp(19));
  assert.equal(calendar('America/New_York')(Date.parse('2026-03-08T04:59:59.999Z')), '2026-03-07');
});

const run = (extra: Partial<RunEvidence> = {}): RunEvidence => ({
  id: 'R1', task: 'T1', role: 'owner', agent: 'codex', session: { provider: 'codex', id: 'session' },
  launch: { adapter: 'codex', values: { model: 'fictional' } },
  state: 'succeeded', created_at: stamp(0), started_at: stamp(10), ended_at: stamp(50), pids: { agent: 12 },
  usage: { includesEarlier: false, run: { input: 3, cacheRead: 4, cacheWrite: 5, output: 6 } },
  ...extra,
});

test('process evidence, elapsed time and first-session attribution have separate rules', () => {
  assert.equal(launchOf(run({ state: 'joined' })), null);
  assert.equal(launchOf(run({ state: 'queued' })), null);
  assert.equal(launchOf(run({ state: 'failed', pids: { agent: null } })), null);
  const ended = launchOf(run())!;
  const live = launchOf(run({ id: 'R2', state: 'running', started_at: stamp(55), ended_at: null, usage: null }))!;
  const includesEarlier = launchOf(run({ usage: { ...run().usage!, includesEarlier: true } }))!;
  assert.equal(runUsageMs(ended, epoch + 400), 40);
  assert.equal(runUsageMs(live, epoch + 75), 20);
  assert.equal(live.tokens, null);
  assert.deepEqual(includesEarlier.tokens, ended.tokens);
  assert.deepEqual([...firstConversations([live, ended])], ['R1']);
  assert.deepEqual([...firstConversations([ended, { ...live, provider: 'another' }])], ['R1', 'R2']);
});

test('review wait, hold, exact question closure and concurrent runs partition wall time', () => {
  const asker = { kind: 'placement', placementId: 'synthetic' } as const;
  const ownLog = [event('start', 'linked', 0, { toState: 'doing' }),
    event('first-asked', 'asked', 12, { askedTo: null, actor: asker, decide: [{}] }),
    event('second-asked', 'asked', 14, { askedTo: null, actor: asker, decide: [{}] }),
    event('second-answer', 'answered', 17, { questionId: 'second-asked' }),
    event('waiting', 'reported', 20, { toState: 'waiting' }),
    event('hold', 'reported', 30, { toState: 'held' }),
    event('doing', 'reported', 35, { toState: 'doing' }),
    event('first-withdrawn', 'question_withdrawn', 39, { questionId: 'first-asked' }),
    event('stop', 'reported', 50, { toState: 'stopped' })];
  const own = userQuestions(ownLog);
  assert.deepEqual(own.map(({ to, answered }) => [to, answered]), [[epoch + 39, false], [epoch + 17, true]]);
  const child = userQuestions([
    event('child-q', 'asked', 39, { askedTo: null, actor: asker, decide: [{}] }),
    event('child-stop', 'reported', 45, { toState: 'stopped' }),
  ]);
  const launch = launchOf(run())!;
  const { time, band } = clocks(ownLog, own, child, [launch, { ...launch, id: 'R2' }], epoch, epoch + 60, epoch + 60);
  assert.deepEqual(time, { review: 10, answer: 18, ai: 7, other: 25 });
  assert.equal(band.find(piece => piece.from === stamp(35))?.to, stamp(39));
});

test('periods use civil days, complete calendar buckets, and a minimum share denominator', () => {
  // The days kept per quarter hour turn when the zone's day does, a 45-minute offset and a DST change included.
  for (const [zone, around] of [['Asia/Kathmandu', '2026-03-08T18:15:00Z'], ['America/New_York', '2026-03-08T05:00:00Z']] as const) {
    const kept = calendar(zone), direct = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' });
    for (let pass = 0; pass < 2; pass++)
      for (let time = Date.parse(around) - 3_600_000; time <= Date.parse(around) + 3_600_000; time += 59_999)
        assert.equal(kept(time), direct.format(time), `${zone} ${new Date(time).toISOString()}`);
  }
  const date = calendar('America/New_York');
  assert.equal(date(Date.parse('2026-03-09T03:59:59Z')), '2026-03-08');
  assert.equal(date(Date.parse('2026-03-09T04:00:00Z')), '2026-03-09');
  const head = makeHead(null, 'America/New_York', '2026-03-09', '2026-02-24', { period: '7d' });
  assert.deepEqual(head.period, { from: '2026-03-03', to: '2026-03-09' });
  assert.deepEqual(head.previous, { from: '2026-02-24', to: '2026-03-02' });
  assert.equal(makeHead(null, 'UTC', head.today, head.firstDay, { period: 'all' }).previous, null);
  assert.deepEqual(buckets('2026-02-28', '2026-03-09', 'month'), [
    { from: '2026-02-28', to: '2026-02-28', complete: false },
    { from: '2026-03-01', to: '2026-03-09', complete: false },
  ]);
  assert.equal(buckets('2026-02-28', '2026-03-09', 'week')[1]!.complete, true);
  const month = { from: '2026-03-01', to: '2026-03-31' };
  assert.deepEqual(makeHead(null, 'America/New_York', month.to, '2026-01-29', month).previous,
    { from: '2026-01-29', to: '2026-02-28' });
  assert.equal(makeHead(null, 'UTC', month.to, '2026-01-30', month).previous, null);
  for (const schema of [analysisTasksInput, analysisUsageInput]) {
    assert.equal(schema.safeParse({ bucket: 'month', ...month }).success, true);
    assert.equal(schema.safeParse({ bucket: 'month', ...month, period: '7d' }).success, false);
    assert.equal(schema.safeParse({ bucket: 'month', ...month, end: month.to }).success, false);
    assert.equal(schema.safeParse({ bucket: 'month', from: month.from }).success, false);
  }
  assert.equal(shareOf(9, 9), null);
  assert.equal(shareOf(9, 10), 0.9);
  assert.equal(analysisListInput.safeParse({ set: 'used', period: 'all', value: 'calls', by: 'model', key: 'some-model' }).success, false);
});

test('PR links use a normalized full repository key', () => {
  const links = prLinks(['[one](https://github.com/Fictional/App/pull/2/files) https://github.com/fictional/app/pull/2#issue',
    'https://github.com/fictional/other/pull/2 https://github.com/fictional/app/pull/abc http://github.com/fictional/app/pull/3']);
  assert.deepEqual([...links], ['https://github.com/fictional/app/pull/2', 'https://github.com/fictional/other/pull/2']);
});

test('Claude and bridge tally each observed tool once, with skill, MCP and delegation evidence', () => {
  const claude = new TallyParser('claude', 'claude', 'session');
  const items = (parent: string | null, ...content: unknown[]) => claude.observe({
    type: 'assistant', session_id: 'session', parent_tool_use_id: parent, message: { content },
  });
  const call = (id: string, name: string, input = {}) => ({ type: 'tool_use', id, name, input });
  items(null, call('skill', 'Skill', { skill: 'example' }), call('read', 'Read', { file_path: '/some/skills/example/SKILL.md' }),
    call('shell', 'Bash', { command: 'head /some/skills/example/references/page.md' }), call('mcp', 'mcp__server__search'));
  items('parent', call('child', 'mcp__server__search'));
  items(null, call('skill', 'Skill', { skill: 'example' }));
  const observed = claude.finish('complete');
  assert.deepEqual(observed.skills.example, { call: 1, read: 2 });
  assert.equal(observed.tools.Skill, 1);
  assert.equal(observed.mcp['server:search'], 1);
  assert.equal(observed.subagentTools, 1);

  for (const adapter of ['codex', 'pi', 'copilot', 'grok']) {
    const bridge = new TallyParser(adapter, adapter, null);
    bridge.observe({ type: 'item.started', item: { id: 'cmd', type: 'command_execution', command: "bash -lc 'cat /a/skills/b/SKILL.md'" } });
    bridge.observe({ type: 'item.completed', item: { id: 'cmd', type: 'command_execution' } });
    bridge.observe({ type: 'item.completed', item: { id: 'image', type: 'image_view' } });
    bridge.observe({ type: 'item.completed', item: { id: 'r', type: 'reasoning' } });
    bridge.observe({ type: 'item.started', item: { id: 'm', type: 'mcp_tool_call' } });
    bridge.observe({ type: 'item.completed', item: { id: 'm', type: 'mcp_tool_call', server: 'server', tool: 'read' } });
    bridge.observe({ type: 'item.completed', item: { id: 'config', type: 'agent_configuration', model: 'test-model' } });
    const counts = bridge.finish('complete');
    assert.deepEqual({ ...counts.tools }, { command_execution: 1, image_view: 1 });
    assert.equal(counts.skills.b?.read, 1);
    assert.equal(counts.mcp['server:read'], 1);
    assert.equal(counts.model, 'test-model');
  }
});

test('Claude and bridge tally skill reads in compound shell commands', () => {
  const commands = [
    "cat '/sample/skills/first/SKILL.md'\ncat '/sample/skills/second/references/owner.md'",
    "echo 'text; cat /sample/skills/quoted/SKILL.md | more' ; cat ~/.example/skills/third/references/owner.md",
    'wc -l ~/.example/skills/fourth/SKILL.md; sed -n 1,200p ~/.example/skills/fourth/SKILL.md',
    'cat /sample/skills/fifth/SKILL.md | head -80; grep -n "^#" /sample/skills/sixth/SKILL.md | head -40',
    'more /sample/skills/seventh/SKILL.md && rg text /sample/skills/eighth/SKILL.md || awk 1 /sample/skills/ninth/SKILL.md',
    'bat /sample/skills/tenth/SKILL.md > /sample/skills/output/SKILL.md',
    'sed -i 1p /sample/skills/edit/SKILL.md; sed -ni.bak 1p /sample/skills/edit/SKILL.md; sed --in-place 1p /sample/skills/edit/SKILL.md',
    'cp /sample/skills/copy/SKILL.md /sample/skills/destination/SKILL.md; mv old /sample/skills/move/SKILL.md',
    'cat "not;a|path" # cat /sample/skills/comment/SKILL.md\ncat /sample/skills/after-comment/SKILL.md',
    "cat <<'NOTE' > /sample/skills/output/SKILL.md\ncat /sample/skills/here-doc/SKILL.md\nNOTE\ncat \\\n /sample/skills/after-here-doc/SKILL.md",
  ];
  const expected = Object.fromEntries([
    'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth',
    'after-comment', 'after-here-doc',
  ].map(skill => [skill, { call: 0, read: 1 }]));
  for (const adapter of ['claude', 'codex']) {
    const parser = new TallyParser(adapter, adapter, null);
    for (const [index, command] of commands.entries()) {
      const id = String(index);
      if (adapter === 'claude') {
        parser.observe({ type: 'assistant', message: { content: [
          { type: 'tool_use', id, name: 'Bash', input: { command } },
        ] } });
      } else {
        const script = "/bin/bash -lc '" + command.replaceAll("'", "'\\''") + "'";
        parser.observe({ type: 'item.started', item: { id, type: 'command_execution', command: script } });
        parser.observe({ type: 'item.completed', item: { id, type: 'command_execution', command: script } });
      }
    }
    assert.deepEqual({ ...parser.finish('complete').skills }, expected, adapter);
  }
});

test('serve reads the analysis ahead once, when it is quiet, and not after it closes', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let warmed = 0, quiet = false;
  const stop = warmAnalysisWhenIdle({ warm: async () => { warmed++; } }, () => quiet);
  t.mock.timers.tick(3000);
  assert.equal(warmed, 0);
  quiet = true;
  t.mock.timers.tick(1000);
  assert.equal(warmed, 1);
  t.mock.timers.tick(60_000);
  assert.equal(warmed, 1);
  stop();
  const closed = warmAnalysisWhenIdle({ warm: async () => { warmed++; } }, () => true);
  closed();
  t.mock.timers.tick(60_000);
  assert.equal(warmed, 1);
});

test('a question asking to take a result is a review round, and an instruction in place of its answer is rework', () => {
  const asker = { kind: 'placement', placementId: 'synthetic' } as const;
  const coordinator = { kind: 'main', provider: 'claude', conversationId: 'synthetic' } as const;
  const accept = [{ decide_question: 'Take the result?', decide_kind: 'accept' }];
  const initial = event('initial', 'request_accepted', 0, { fromState: 'todo' });
  const asked = event('asked', 'asked', 10, { askedTo: null, actor: asker, decide: accept });
  const fix = event('fix', 'request_accepted', 20, { fromState: 'doing', actor: coordinator });
  const withdrawn = event('withdrawn', 'question_withdrawn', 20, { questionId: asked.id, originCauseId: fix.id, actor: coordinator });
  const again = event('again', 'asked', 30, { askedTo: null, actor: asker, decide: accept });
  const yes = event('yes', 'answered', 40, { questionId: again.id });
  const submit = event('submit', 'reported', 50, { fromState: 'doing', toState: 'waiting' });
  const approved = event('approved', 'review_approved', 60, { fromState: 'waiting', toState: 'done' });
  const start = event('start', 'linked', 0, { fromState: 'todo', toState: 'doing' });
  const log = [initial, start, asked, withdrawn, fix, again, yes, submit, approved];
  const outcome = taskOutcome(log, 'done', initial.at, userQuestions(log));
  assert.deepEqual([outcome.submits, outcome.passed, outcome.estimated], [3, false, false]);
  assert.deepEqual(outcome.instructions, { sendBacks: 0, instructionsAtReview: 1, instructionsAfterAccept: 0, instructionsDuringWork: 0 });
  // Answered at once: two rounds (the question and the submit), still taken as it was.
  const clean = [initial, again, yes, submit, approved];
  assert.equal(taskOutcome(clean, 'done', initial.at, userQuestions(clean)).passed, true);
  // A child's question replaced in the child's own log is the unit's rework too.
  const child = userQuestions([asked, withdrawn, fix]);
  assert.equal(taskOutcome(clean, 'done', initial.at, [...userQuestions(clean), ...child]).passed, false);
  // Before decide_kind was recorded, the question's words decide, and the count says it was read so.
  const older = [initial, { ...again, decide: [{ decide_question: 'PR #1 を main にマージしてよいか' }] }, yes, submit, approved];
  assert.deepEqual(userQuestions(older).map(({ accept, estimated }) => [accept, estimated]), [[true, true]]);
  assert.equal(taskOutcome(older, 'done', initial.at, userQuestions(older)).estimated, true);
  // Its open time is review time, not answer time.
  const { time, waits } = clocks(log, userQuestions(log), [], [], epoch, epoch + 60, epoch + 60);
  assert.deepEqual([time.review, time.answer], [10 + 10 + 10, 0]);
  assert.deepEqual(waits, [{ from: epoch + 10, to: epoch + 20 }, { from: epoch + 30, to: epoch + 40 }, { from: epoch + 50, to: epoch + 60 }]);
});

test('a wait is split by where the user was: away after 30 idle minutes, else the task of their next action', () => {
  const minute = 60_000, at = (m: number) => epoch + m * minute;
  const activity = [{ at: at(-5), task: 'T1' }, { at: at(10), task: 'T2' }, { at: at(20), task: null },
    { at: at(200), task: 'T3' }, { at: at(210), task: 'T9' }, { at: at(215), task: 'T1' }];
  const here = (task: string) => task === 'T1' || task === 'T9';
  // 0–10 before an action on another task, 10–20 before a message naming no task, 20–200 away, then 200–215 before
  // actions on a task under this one and on this one.
  assert.deepEqual(splitWaits([{ from: at(0), to: at(215) }], activity, here, at(300)),
    { away: 180 * minute, otherTasks: 20 * minute, thisTask: 15 * minute });
  // A wait still open runs to now: free for this task until 30 minutes pass, away after.
  assert.deepEqual(splitWaits([{ from: at(216), to: at(240) }], activity, here, at(240)), { away: 0, otherTasks: 0, thisTask: 24 * minute });
  assert.deepEqual(splitWaits([{ from: at(216), to: at(300) }], activity, here, at(300)), { away: 84 * minute, otherTasks: 0, thisTask: 0 });
});

test('clues count answers by item, replaced questions and labeled instructions, most frequent kind first', () => {
  const question = (fields: object) => ({ id: 'q', from: 0, to: 1, answered: true, accept: false, estimated: false,
    replacedBy: null, parts: null, recommends: [true, false], ...fields });
  const unit = { asked: [
    question({ parts: { source: 'user', words: false, items: [
      { n: 1, kind: 'choice', choice: 1, recommended: true, words: false }, { n: 2, kind: 'unmatched', words: true }] } }),
    question({}), question({ answered: false, replacedBy: 'fix' })],
  instructions: { count: 3, labels: [{ request: 'a', kind: 'fix', fixes: ['look_feel', 'speed'] },
    { request: 'b', kind: 'fix', fixes: ['look_feel'] }] } } as unknown as Parameters<CluesSum['add']>[0];
  const sum = new CluesSum();
  sum.add(unit, { away: 1, otherTasks: 2, thisTask: 3 });
  assert.deepEqual(sum.clues(), { waits: { away: 1, otherTasks: 2, thisTask: 3 },
    answerItems: { total: 2, choice: 1, recommended: 1, recommendable: 1, other: 0, stop: 0, unmatched: 1 },
    answersWithoutParts: 1, questionsReplaced: 1,
    instructions: { total: 3, unlabeled: 1, kinds: [{ kind: 'fix', count: 2 }], fixes: [{ kind: 'look_feel', count: 2 }, { kind: 'speed', count: 1 }] } });
});
