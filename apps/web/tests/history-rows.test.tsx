import { beforeAll, expect, test } from 'vitest';
import { i18n, startI18n } from '@alpacawork/i18n';
beforeAll(async () => { startI18n(); await i18n.changeLanguage('en'); });
import type { OpenTask } from '../src/domain/flow';
import { answerLine, historyRows, recordKey, rowTargets } from '../src/domain/history-rows';
import type { ReportEvent } from '../src/domain/report-events';

const tasks: Record<string, { parentId: string | null; title: string }> = {
  T0: { parentId: null, title: '上' }, T1: { parentId: 'T0', title: '親の題' }, T2: { parentId: 'T1', title: '開いた題' },
  T3: { parentId: 'T2', title: '子の題' }, T4: { parentId: 'T1', title: '兄弟の題' }, T5: { parentId: 'T3', title: '孫の題' },
};
const open: OpenTask = { id: 'T2', parentId: 'T1' };
let n = 0;
const row = (fields: Partial<ReportEvent>): ReportEvent => { n += 1; return { key: `k${n}`, id: `i${n}`, at: '2026-11-01T00:00:00.000Z', kind: 'comment', text: `言葉${n}`, description: null, taskId: 'T2', mark: { kind: 'report', tone: 'working' }, ...fields }; };
const rows = (...reports: ReportEvent[]) => historyRows(reports, open, id => tasks[id]);
const owner = { kind: 'owner', profileKey: 'claude' } as const;
const by = (taskId: string) => ({ kind: 'parent', taskId, profileKey: 'claude' }) as const;
const child = { taskId: 'T3', sourceTaskId: 'T3' };

test('every record names both ends from left to right, and its mark says whether it went up or down the chain of command', () => {
  const said = (fields: Partial<ReportEvent>) => { const [r] = rows(row(fields)); return [r!.name, r!.way]; };
  const self = { party: 'self' };
  const between = (from: object, to: object, way: string) => [{ ends: [from, to] }, way];
  const parent = { party: 'parent', taskId: 'T1', title: '親の題' }, kid = { party: 'child', taskId: 'T3', title: '子の題' };
  // Down: a request or an answer to someone under whom it came from.
  expect(said({ kind: 'request', author: { kind: 'human' }, by: 'human' })).toEqual(between({ party: 'you' }, self, 'down'));
  expect(said({ kind: 'request', author: { kind: 'main' }, by: 'main' })).toEqual(between({ party: 'coordinator' }, self, 'down'));
  expect(said({ kind: 'request', author: by('T1'), recipient: { role: 'owner', profileKey: 'claude' } })).toEqual(between(parent, self, 'down'));
  expect(said({ kind: 'request', ...child, author: by('T2') })).toEqual(between(self, kid, 'down'));
  expect(said({ kind: 'request', author: owner, recipient: { role: 'member', profileKey: 'codex' } })).toEqual(between(self, { party: 'member' }, 'down'));
  expect(said({ kind: 'request', ...child, author: { kind: 'human' }, by: 'human' })).toEqual(between({ party: 'you' }, kid, 'down'));
  expect(said({ kind: 'answer', ...child, author: { kind: 'main' }, by: 'main', answers: 'q', text: '' })).toEqual(between({ party: 'coordinator' }, kid, 'down'));
  // Up: a report, a question or a record to someone above whom it came from, an ancestor further up too.
  expect(said({ kind: 'report', author: owner })).toEqual(between(self, parent, 'up'));
  expect(said({ kind: 'report', ...child, author: owner })).toEqual(between(kid, self, 'up'));
  expect(said({ kind: 'question', author: owner, askedTo: 'T0' })).toEqual(between(self, { party: 'other', taskId: 'T0', title: '上' }, 'up'));
  expect(said({ kind: 'question', author: owner, askedTo: 'user' })).toEqual(between(self, { party: 'you' }, 'up'));
  expect(said({ kind: 'comment', author: { kind: 'member', profileKey: 'codex' } })).toEqual(between({ party: 'member' }, self, 'up'));
  // Neither: between two that are not one above the other, or a record of the open Task alone.
  expect(said({ kind: 'comment', author: by('T4') })).toEqual(between({ party: 'other', taskId: 'T4', title: '兄弟の題' }, self, 'by'));
  expect(said({ kind: 'comment', author: owner })).toEqual([{ own: self }, 'by']);
  // Further down the tree: a grandchild asks the open Task (up), and is answered (down).
  const grandchild = { party: 'other', taskId: 'T5', title: '孫の題' };
  expect(said({ kind: 'question', taskId: 'T5', sourceTaskId: 'T5', author: owner, askedTo: 'T2' })).toEqual(between(grandchild, self, 'up'));
  expect(said({ kind: 'answer', taskId: 'T5', sourceTaskId: 'T5', author: by('T2'), answers: 'q', text: '' })).toEqual(between(self, grandchild, 'down'));
  // A Task the tree does not know is neither above nor under.
  expect(said({ kind: 'comment', author: by('T9') })[1]).toBe('by');
  // The open Task missing from the index still has its own parent, so a question past it goes up.
  const [unindexed] = historyRows([row({ kind: 'question', author: owner, askedTo: 'T0' })], open, id => id === 'T2' ? undefined : tasks[id]);
  expect(unindexed!.way).toBe('up');
});

test('a row stands for each record: a member\'s words, a child\'s request and an answer are not folded under another', () => {
  const asked = row({ kind: 'question', ...child, author: owner, askedTo: 'T2' });
  const answer = row({ kind: 'answer', ...child, author: by('T2'), answers: asked.id, text: '', answerText: '1-数えません', description: '1-数えません', mark: null });
  const member = row({ kind: 'comment', author: { kind: 'member', profileKey: 'codex' } });
  const shown = rows(member, answer, asked);
  expect(shown.map(each => each.key)).toEqual([member.key, answer.key, asked.key]);
  expect(shown[2]!.outcome).toEqual({ kind: 'answered', who: 'self', at: answer.at });
  expect(shown[1]!.asks).toBe(asked.text);
  expect(answerLine('1-数えません\n理由')).toBe('数えません');
});

test('the same words over the same body in a row are one row that holds the older ones; a different body keeps its own', () => {
  const same = { kind: 'review' as const, author: owner, text: '区切りの報告', released: 'invalidated' as const };
  const newest = row({ ...same, description: 'b' }), middle = row({ ...same, description: 'b' }), other = row({ ...same, description: 'a' });
  const shown = rows(newest, middle, other);
  expect(shown.map(each => each.key)).toEqual([newest.key, other.key]);
  expect(shown[0]!.older.map(each => each.key)).toEqual([middle.key]);
  expect(shown[1]).toMatchObject({ sameTitle: true, older: [] });
  expect(shown[1]!.outcome).toEqual({ kind: 'again', question: false });
  expect(rowTargets(shown).get(middle.key)).toBe(newest.key);
  // Another kind, another Task, or a record still to be acted on is no repeat.
  expect(rows(row({ text: '別' }), row({ text: '別', kind: 'report' })).map(each => each.older.length)).toEqual([0, 0]);
  expect(rows(row({ text: '別', ...child }), row({ text: '別', taskId: 'T4', sourceTaskId: 'T4' })).map(each => each.older.length)).toEqual([0, 0]);
  expect(rows(row({ text: '別' }), row({ text: '別', question: 'q' })).map(each => each.older.length)).toEqual([0, 0]);
});

test('a wait that closed says why, from the next record of its Task', () => {
  const review = { kind: 'review' as const, author: owner, released: 'invalidated' as const };
  const asked = { kind: 'question' as const, author: owner, askedTo: 'T1' as const, released: 'withdrawn' as const };
  expect(rows(row({ kind: 'request', author: { kind: 'human' }, by: 'human' }), row(review))[1]!.outcome).toEqual({ kind: 'resumed', question: false });
  expect(rows(row({ ...review, text: '次' }), row(review))[1]!.outcome).toEqual({ kind: 'replaced', question: false });
  expect(rows(row(asked))[0]!.outcome).toEqual({ kind: 'closed', why: 'withdrawn' });
  // Withdrawn before the next question came: that question did not replace it.
  const later = row({ ...asked, text: '次', released: undefined, at: '2026-11-01T00:09:00.000Z' });
  const withdrawal = row({ kind: 'withdrawn', text: '', mark: null, author: owner, at: '2026-11-01T00:05:00.000Z' });
  expect(rows(later, withdrawal, row(asked)).at(-1)!.outcome).toEqual({ kind: 'closed', why: 'withdrawn' });
  const atOnce = row({ ...asked, text: '次', released: undefined, at: '2026-11-01T00:05:00.000Z' });
  expect(rows(atOnce, withdrawal, row(asked)).at(-1)!.outcome).toEqual({ kind: 'replaced', question: true });
  expect(rows(row({ ...review, released: 'stopped' }))[0]!.outcome).toEqual({ kind: 'closed', why: 'stopped' });
  expect(rows(row({ kind: 'question', pinned: true, author: owner, askedTo: 'T1' }))[0]!.outcome).toEqual({ kind: 'waiting', on: 'parent', review: false });
  expect(rows(row({ kind: 'confirm', author: { kind: 'human' }, by: 'human' }), row({ kind: 'review', author: owner }))[1]!.outcome).toMatchObject({ kind: 'confirmed', who: 'you' });
});

test('a review uses the last matching confirmation in input order, including equal times', () => {
  const review = row({ kind: 'review', author: owner });
  const newer = row({ kind: 'confirm', author: { kind: 'human' }, at: '2026-11-01T00:05:00.000Z' });
  const equalFirst = row({ kind: 'confirm', author: { kind: 'human' }, at: review.at });
  const equal = row({ kind: 'confirm', author: { kind: 'main' }, at: review.at });
  const tooEarly = row({ kind: 'confirm', author: { kind: 'human' }, at: '2026-10-31T23:59:59.999Z' });
  const elsewhere = row({ kind: 'confirm', ...child, author: { kind: 'human' }, at: newer.at });
  const outcome = (wait: ReportEvent, ...confirms: ReportEvent[]) => rows(...confirms, wait).at(-1)!.outcome;
  // Input order wins even when timestamps are not sorted; neither another Task nor an earlier time qualifies.
  expect(outcome(review, equalFirst, newer, equal, tooEarly, elsewhere)).toEqual({ kind: 'confirmed', who: 'coordinator', at: equal.at });
  expect(outcome(review, tooEarly, elsewhere)).toBeNull();
  expect(outcome({ ...review, pinned: true }, newer)).toEqual({ kind: 'waiting', on: 'you', review: true });
  expect(outcome({ ...review, released: 'stopped' }, newer)).toEqual({ kind: 'closed', why: 'stopped' });
});

test('closed waits use the nearest later record of their own Task and kind, skipping member requests', () => {
  const old = row({ kind: 'question', author: owner, askedTo: 'T1', released: 'withdrawn', text: 'old' });
  const nearer = row({ kind: 'question', author: owner, askedTo: 'T1', released: 'withdrawn', text: 'nearer' });
  const latest = row({ kind: 'question', author: owner, askedTo: 'T1', text: 'nearer' });
  const review = row({ kind: 'review', author: owner, released: 'invalidated' });
  const request = row({ kind: 'request', author: owner });
  const member = row({ kind: 'request', author: owner, recipient: { role: 'member', profileKey: 'codex' } });
  const elsewhere = row({ kind: 'question', ...child, author: owner });
  const shown = rows(latest, request, nearer, member, elsewhere, review, old);
  const outcome = (report: ReportEvent) => shown.find(each => each.key === report.key)!.outcome;
  expect(outcome(old)).toEqual({ kind: 'replaced', question: true });
  expect(outcome(nearer)).toEqual({ kind: 'resumed', question: true });
  expect(outcome(review)).toEqual({ kind: 'resumed', question: false });
  // A question does not replace a review, and a member request does not resume it.
  expect(rows(latest, member, elsewhere, review).at(-1)!.outcome).toEqual({ kind: 'closed', why: 'invalidated' });
});

test('a dialogue stands as your words and the Coordinator\'s reply, each with its own name', () => {
  const said = row({ kind: 'dialogue', author: { kind: 'human' }, text: '聞きます', description: '**答え**です\n続き', mark: null });
  const [reply, words] = rows(said);
  expect([reply!.name, reply!.way]).toEqual([{ ends: [{ party: 'coordinator' }, { party: 'you' }] }, 'up']);
  expect(reply!.report).toMatchObject({ replyTo: said.key, text: '答えです', description: said.description });
  // Your words go to the Coordinator, who answers in the row above: neither end is the open Task.
  expect([words!.name, words!.way]).toEqual([{ ends: [{ party: 'you' }, { party: 'coordinator' }] }, 'down']);
  // Your words are the record's own row and its body; each row is its own address.
  expect(words!.report).toMatchObject({ key: said.key, description: '聞きます' });
  expect([reply!.key, words!.key]).toEqual([`${said.key}:reply`, said.key]);
  expect(rowTargets([reply!, words!]).get(said.key)).toBe(said.key);
  expect([recordKey(reply!.key), recordKey(words!.key)]).toEqual([said.key, said.key]);
});

// A record that says anything else than the one above it keeps its row.
test('a record to or from someone else, with another note, or asking or closed otherwise is never folded into the one above', () => {
  const twice = (a: Partial<ReportEvent>, b: Partial<ReportEvent>) => rows(row({ text: '同じ依頼', description: '確かめてください', ...a }), row({ text: '同じ依頼', description: '確かめてください', ...b }));
  const request = { kind: 'request' as const, mark: null, author: owner };
  const cases: [string, Partial<ReportEvent>, Partial<ReportEvent>][] = [
    ['recipient', { ...request, recipient: { role: 'owner', profileKey: 'claude' } }, { ...request, recipient: { role: 'member', profileKey: 'codex' } }],
    ['member agent', { ...request, recipient: { role: 'member', profileKey: 'claude' } }, { ...request, recipient: { role: 'member', profileKey: 'codex' } }],
    ['author', { kind: 'comment', author: owner }, { kind: 'comment', author: { kind: 'member', profileKey: 'codex' } }],
    ['note', { kind: 'request', mark: null, author: { kind: 'human' }, by: 'human', note: { title: '新しい補足', description: '赤く直してください' } },
      { kind: 'request', mark: null, author: { kind: 'human' }, by: 'human', note: { title: '別の補足', description: '青く直してください' } }],
    ['question destination', { kind: 'question', author: owner, askedTo: 'user', released: 'withdrawn' }, { kind: 'question', author: owner, askedTo: 'T1', released: 'withdrawn' }],
    ['question ending', { kind: 'question', author: owner, askedTo: 'user', released: 'withdrawn' }, { kind: 'question', author: owner, askedTo: 'user', released: 'expired' }],
    ['taken in', { ...child, kind: 'report', author: owner, consumedBy: ['R1'] }, { ...child, kind: 'report', author: owner }],
    // A stop under the same words as a done must not read as a second done.
    ['state set', { ...child, kind: 'report', author: owner, set: 'done' }, { ...child, kind: 'report', author: owner, set: 'stopped' }],
    // Each member Request keeps the way to its own result.
    ['result', { ...request, recipient: { role: 'member', profileKey: 'codex' }, result: { runId: 'R1', at: '2026-11-01T00:01:00.000Z' } },
      { ...request, recipient: { role: 'member', profileKey: 'codex' }, result: { runId: 'R2', at: '2026-11-01T00:02:00.000Z' } }],
  ];
  for (const [name, a, b] of cases) expect([name, twice(a, b).map(each => each.older.length)]).toEqual([name, [0, 0]]);
  // Only its body or its note is what such a row says differs; another addressee or ending is said by the row itself.
  expect(twice(cases[0]![1], cases[0]![2])[1]!.sameTitle).toBe(false);
  expect(twice(cases[5]![1], cases[5]![2]).map(each => [each.sameTitle, each.outcome])).toEqual([[false, { kind: 'closed', why: 'withdrawn' }], [false, { kind: 'closed', why: 'expired' }]]);
  expect(twice(cases[3]![1], cases[3]![2])[1]!.sameTitle).toBe(true);
  // The same record again, to the same people with the same note, is one row; so is one that kept the state the one
  // before it set, as long as the row draws it the same.
  expect(twice(cases[3]![1], cases[3]![1]).map(each => each.older.length)).toEqual([1]);
  expect(twice({ ...child, kind: 'report', author: owner }, { ...child, kind: 'report', author: owner, set: 'waiting' }).map(each => each.older.length)).toEqual([1]);
});


test('member names use the recorded model and effort, with honest missing values and no folding across model changes', () => {
  const member = { kind: 'member' as const, profileKey: 'claude', modelId: 'opus', effort: 'high' };
  const recorded = row({ author: member, text: 'Same words' });
  const member0 = (r: ReturnType<typeof rows>[number]) => 'ends' in r.name ? r.name.ends[0] : r.name.own;
  expect(rows(recorded)[0]!.name).toEqual({ ends: [{ party: 'member', agent: 'opus(high)' }, { party: 'self' }] });
  expect(rows(row({ kind: 'request', author: owner, recipient: { role: 'member', profileKey: member.profileKey, modelId: member.modelId, effort: member.effort } }))[0]!.name)
    .toEqual({ ends: [{ party: 'self' }, { party: 'member', agent: 'opus(high)' }] });
  expect(member0(rows(row({ author: { ...member, effort: null } }))[0]!)).toEqual({ party: 'member', agent: 'opus(unknown)' });
  // No Run linked to the record: the end is named by its word alone, never by a guessed model.
  expect(member0(rows(row({ author: { kind: 'member', profileKey: 'claude' } }))[0]!)).toEqual({ party: 'member' });
  expect(member0(rows(row({ author: { ...member, modelId: null, effort: 'low' } }))[0]!)).toEqual({ party: 'member', agent: 'claude(low)' });
  expect(rows(recorded, row({ author: { ...member, modelId: 'sonnet' }, text: 'Same words' })).map(each => each.older.length)).toEqual([0, 0]);
  expect(rows(recorded, row({ author: { ...member, effort: 'low' }, text: 'Same words' })).map(each => each.older.length)).toEqual([0, 0]);
});

test('every end but yours is named by the Run at that end: the writer, the Run that took it in, the Coordinator\'s', () => {
  const opus = { profileKey: 'claude', modelId: 'opus', effort: 'high' };
  const sol = { profileKey: 'codex', modelId: 'gpt-6.1-sol', effort: 'medium' };
  const ends = (fields: Partial<ReportEvent>) => { const name = rows(row(fields))[0]!.name; return 'ends' in name ? name.ends : [name.own]; };
  // A child's report, taken in by the open Task's Run: both ends by their Runs.
  expect(ends({ kind: 'report', ...child, author: { kind: 'owner', ...opus }, recipient: { role: 'owner', ...sol } }))
    .toEqual([{ party: 'child', taskId: 'T3', title: '子の題', agent: 'opus(high)' }, { party: 'self', agent: 'gpt-6.1-sol(medium)' }]);
  // The open Task's report to its parent, which no Run took in yet: the parent by its word alone.
  expect(ends({ kind: 'report', author: { kind: 'owner', ...sol } })).toEqual([{ party: 'self', agent: 'gpt-6.1-sol(medium)' }, { party: 'parent', taskId: 'T1', title: '親の題' }]);
  // The parent's request, accepted by the open Task's Run; the parent by the Run that sent it.
  expect(ends({ kind: 'request', author: { kind: 'parent', taskId: 'T1', ...opus }, recipient: { role: 'owner', ...sol } }))
    .toEqual([{ party: 'parent', taskId: 'T1', title: '親の題', agent: 'opus(high)' }, { party: 'self', agent: 'gpt-6.1-sol(medium)' }]);
  // The Coordinator by the Run that took the screen message, at either end; without one, by its word alone.
  const said = row({ kind: 'dialogue', author: { kind: 'human' }, text: '聞きます', description: '答えです', mark: null, coordinator: opus });
  const [reply, words] = rows(said);
  expect(reply!.name).toEqual({ ends: [{ party: 'coordinator', agent: 'opus(high)' }, { party: 'you' }] });
  expect(words!.name).toEqual({ ends: [{ party: 'you' }, { party: 'coordinator', agent: 'opus(high)' }] });
  expect(ends({ kind: 'request', author: { kind: 'main' }, by: 'main', coordinator: { ...opus, modelId: null } })[0]).toEqual({ party: 'coordinator', agent: 'claude(high)' });
  expect(ends({ kind: 'request', author: { kind: 'main' }, by: 'main' })[0]).toEqual({ party: 'coordinator' });
  // A record of the open Task alone, by the Run that wrote it.
  expect(ends({ kind: 'comment', author: { kind: 'owner', ...opus } })).toEqual([{ party: 'self', agent: 'opus(high)' }]);
});


test('repeat folding compares both ends with their original missing agent normalization', () => {
  const base = { role: 'owner' as const, profileKey: 'claude', modelId: 'opus', effort: 'high' };
  const agentCases = [
    { ...base, role: 'member' as const },
    { ...base, profileKey: 'codex' },
    { ...base, modelId: 'sonnet' },
    { ...base, effort: 'low' },
  ];
  const pair = (left: Partial<ReportEvent>, right: Partial<ReportEvent>) => rows(
    row({ kind: 'request', text: 'Same words', ...left }), row({ kind: 'request', text: 'Same words', ...right }));
  // The author's role is recorded as kind, the recipient's as role; each side matters independently.
  for (const other of agentCases) {
    const author = (agent: typeof other) => ({ ...agent, kind: agent.role });
    expect(pair({ author: author(base) }, { author: author(other) }).length).toBe(2);
    expect(pair({ recipient: base }, { recipient: other }).length).toBe(2);
  }
  // An omitted profile is the empty profile; omitted model/effort are null, but empty strings remain distinct.
  expect(pair({ author: { kind: 'main' }, coordinator: { profileKey: '' } }, { author: { kind: 'main' } })).toHaveLength(1);
  expect(rows(row({ kind: 'report', text: 'Same words', recipient: { role: 'owner', profileKey: '' } }),
    row({ kind: 'report', text: 'Same words' }))).toHaveLength(1);
  for (const agent of [{ modelId: null, effort: null }, { modelId: '', effort: null }, { modelId: null, effort: '' }]) {
    const count = agent.modelId === null && agent.effort === null ? 1 : 2;
    expect(pair({ author: { kind: 'owner', profileKey: '', ...agent } }, { author: { kind: 'owner', profileKey: '' } })).toHaveLength(count);
    expect(pair({ recipient: { role: 'owner', profileKey: '', ...agent } }, { recipient: { role: 'owner', profileKey: '' } })).toHaveLength(count);
  }
  // No destination remains equal to no destination; an explicit destination still differs.
  expect(rows(row({ text: 'Same words' }), row({ text: 'Same words' }))).toHaveLength(1);
  expect(rows(row({ text: 'Same words', author: { kind: 'human' } }), row({ text: 'Same words' }))).toHaveLength(2);
});

test('a question asked of the person is answered by them, though the coordinator writes their answer', () => {
  const asked = row({ kind: 'question', author: owner, askedTo: 'user' });
  const answer = row({ kind: 'answer', author: { kind: 'main' }, by: 'main', answers: asked.id, text: '', answerText: '1-other B のままで', mark: null });
  expect(rows(answer, asked)[1]!.outcome).toEqual({ kind: 'answered', who: 'you', at: answer.at });
  // Other is answered by the person's own words, not by the word the app keeps for it.
  expect(answerLine('1-other B のままで')).toBe('B のままで');
});
