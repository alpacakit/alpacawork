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
