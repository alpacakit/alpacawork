/** Run graph, admission and lifecycle decisions for current delivery. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as rules from '@alpacawork/runs';
import type { StoredRequest } from '@alpacawork/runs';
import { RUN_ENDED_STATES, RUN_STATE, RUN_STATE_REASONS } from '@alpacawork/contract/run';
import { record, ended, ids } from './runs-fixtures.ts';

const human = { kind: 'human' } as const, placement = { kind: 'placement', placementId: 'P1' } as const;
const main = { kind: 'main', provider: 'claude', conversationId: 'main' } as const;
const quoted = { ...main, quote: 'Go on with the release' } as const;
const session = { provider: 'codex', id: 'conversation' } as const;
const request = (id: string, source: 'human' | 'main' | 'placement' | 'review' | 'returns', taskId = 'T1', placementId = 'P1',
  author: StoredRequest['author'] = placement, deliveryState: StoredRequest['deliveryState'] = 'queued') =>
  ({ id, purpose: source === 'returns' ? 'return_continuation' as const : source === 'review' ? 'review_send_back' as const : 'instruction' as const, taskId, placementId, author, deliveryState, submittedAt: `2026-10-11T00:00:${id.padStart(2, '0')}Z` });

test("automatic Requests count per placement, a placement's and its own seat's continuations (returns) alike", () => {
  const items = [request('01', 'placement'), request('02', 'returns'), request('03', 'placement', 'T2', 'P2'),
    request('04', 'returns', 'T2', 'P2'), request('05', 'placement', 'T1', 'P1', placement, 'aborted'),
    request('06', 'returns', 'T1', 'P1', placement, 'recorded_unconfirmed')];
  assert.equal(rules.automaticIndex(items).count('P1', ['T1', 'T0']), 2, 'an aborted or unconfirmed Request is not counted');
  assert.equal(rules.automaticIndex(items).count('P2', ['T2', 'T1', 'T0']), 2);
  assert.equal(rules.automaticLimitReached(items, 'P1', ['T1', 'T0'], 2), true);
  assert.equal(rules.automaticLimitReached(items, 'P1', ['T1', 'T0'], 3), false);
});

test('a person or main conversation counts again from zero independently of optional quote records, and only from the ancestry', () => {
  const after = (next: ReturnType<typeof request>) =>
    rules.automaticIndex([request('01', 'placement'), request('02', 'returns'), next, request('04', 'returns')]).count('P1', ['T1', 'T0']);
  assert.equal(after(request('03', 'human', 'T1', 'P1', human)), 1);
  assert.equal(after(request('03', 'human', 'T0', 'P0', human)), 1, 'to an ancestor');
  assert.equal(after(request('03', 'review', 'T1', 'P1', human)), 1, "the user's send-back");
  assert.equal(after(request('03', 'main', 'T1', 'P1', quoted)), 1, 'a main conversation with a verified quote');
  assert.equal(after(request('03', 'main', 'T1', 'P1', main)), 1, 'a main conversation without a quote also resets');
  assert.equal(after(request('03', 'human', 'T9', 'P9', human)), 3, 'a Request outside the ancestry does not');
  assert.equal(after(request('03', 'human', 'T1', 'P1', human, 'aborted')), 3, 'an aborted one does not');
});

test('automatic count uses the latest locale-ordered reset in unordered input without mutating it', () => {
  const early = request('01', 'placement'), middle = request('03', 'returns'), late = request('05', 'placement');
  const reset = request('02', 'human', 'T0', 'P0', human), latest = request('04', 'main', 'T1', 'P1', main);
  const items = Object.freeze([late, reset, early, latest, middle]);
  assert.equal(rules.automaticIndex(items).count('P1', ['T1', 'T0']), 1);
  assert.deepEqual(items, [late, reset, early, latest, middle]);
  // These represent the same instant, but the established rule orders their text.
  const timestamp = '2026-10-11T00:00:01Z';
  const textualEarlier = { ...early, submittedAt: '2026-10-11T00:00:01.000Z' };
  assert.equal(rules.automaticIndex([textualEarlier, { ...reset, submittedAt: timestamp }]).count('P1', ['T1', 'T0']), 0);
  // ICU collation also differs from raw string comparison for timezone signs.
  assert.equal(rules.automaticIndex([{ ...early, submittedAt: '2026-10-11T00:00:01+09:00' },
    { ...reset, submittedAt: '2026-10-11T00:00:01-09:00' }]).count('P1', ['T1', 'T0']), 1);
});

test('equal timestamps retain array order and reset wins over a user-authored continuation', () => {
  const timestamp = '2026-10-11T00:00:01Z';
  const automatic = { ...request('01', 'returns'), submittedAt: timestamp };
  const reset = { ...request('02', 'returns', 'T1', 'P1', human), submittedAt: timestamp };
  assert.equal(rules.automaticIndex([automatic, reset, automatic, reset, automatic]).count('P1', ['T1']), 1);
  assert.equal(rules.automaticIndex([reset, automatic, automatic]).count('P1', ['T1']), 2);
  assert.equal(rules.automaticIndex([automatic, automatic, reset]).count('P1', ['T1']), 0);
});

test('rejected resets and users outside the ancestry preserve accepted automatic counts', () => {
  const items = [request('06', 'returns'), request('03', 'human', 'T0', 'P0', human, 'recorded_unconfirmed'),
    request('01', 'placement'), request('04', 'human', 'T1', 'P1', human, 'aborted'),
    request('02', 'returns', 'T9', 'P1', human), request('05', 'returns', 'T1', 'P2')];
  assert.equal(rules.automaticIndex(items).count('P1', ['T1', 'T0']), 3);
});

test('automatic count compares at most linearly many timestamps for an unordered request batch', () => {
  const items = Array.from({ length: 512 }, (_, index) => ({
    ...request(String(index), index % 7 === 0 ? 'human' : 'placement', 'T1', 'P1', index % 7 === 0 ? human : placement),
    submittedAt: `2026-10-11T${String(index * 193 % 512).padStart(4, '0')}`,
  }));
  const compare = String.prototype.localeCompare;
  let comparisons = 0;
  String.prototype.localeCompare = function (...args: Parameters<typeof compare>) { comparisons++; return compare.apply(this, args); };
  try {
    rules.automaticIndex(items).count('P1', ['T1']);
    assert.ok(comparisons <= items.length * 2, `${comparisons} comparisons for ${items.length} Requests`);
  } finally { String.prototype.localeCompare = compare; }
});

test('same seat continuation does not add delegation depth, while worker and child work do', () => {
  const root = record('R1');
  const resumed = record('R2', { caller: { run: root.id }, resumes: root.id });
  const worker = record('R3', { caller: { run: resumed.id }, role: 'worker' });
  const child = record('R4', { caller: { run: resumed.id }, task: 'T2' });
  const all = [root, resumed, worker, child];
  assert.deepEqual(all.map(run => rules.depth(all, run)), [1, 1, 2, 2]);
  assert.deepEqual(ids(rules.descendants(all, root.id)), ['R1', 'R2', 'R3', 'R4']);
  assert.equal(rules.checkRunLimits(all, { caller: { run: worker.id }, continues: false,
    task: 'T3', role: 'owner', resumes: null }, { depth: 2, children_per_run: 20 }), 'too_deep');
});

test('child count, slot and stop rules retain their boundaries', () => {
  const parent = ended('R1', { session }), child = ended('R2', { caller: { run: 'R1' }, role: 'worker' });
  const input = { caller: { run: 'R1' } as const, continues: false, task: 'T2', role: 'owner' as const, resumes: null };
  assert.equal(rules.checkRunLimits([parent, child], input, { depth: 4, children_per_run: 1 }), 'too_many_children');
  assert.equal(rules.checkRunLimits([parent, child], { ...input, continues: true }, { depth: 4, children_per_run: 1 }), null);
  assert.equal(rules.stopEffect([parent, child], parent), 'hold');
  assert.equal(rules.stopEffect([parent, child], record('R3', { state: 'running' })), 'request');
  assert.equal(rules.stopEffect([parent, child], record('R3')), 'cancel');
  assert.equal(rules.stopEffect([parent, child], record('R3', {
    state: 'needs_review', reason: 'manager_lost', pids: { manager: 42, agent: 43 },
  })), 'request');
  assert.equal(rules.stopEffect([parent, child], record('R3', {
    state: 'needs_review', reason: 'manager_lost', pids: { manager: null, agent: null },
  })), 'hold');
  for (const state of Object.values(RUN_STATE)) for (const reason of RUN_STATE_REASONS[state]) {
    const run = record('R5', { state, reason, session });
    const slot = state === 'running' || state === 'needs_review' && reason !== 'conversation_busy';
    assert.equal(rules.usesSlot(run), slot);
    assert.equal(rules.conversationInUse([run], session.id), slot);
  }
});

test('ended and unfinished use the same state set as SQL', () => {
  for (const state of Object.values(RUN_STATE)) {
    const unfinished = !(RUN_ENDED_STATES as readonly string[]).includes(state);
    assert.equal(rules.isUnfinished({ state }), unfinished);
    assert.equal(rules.UNFINISHED_SQL.split(', ').includes(`'${state}'`), unfinished);
  }
});

test('transition matrix refuses an unrelated reason and allows a manager review to settle', () => {
  assert.equal(rules.canTransition({ state: 'queued', reason: null }, { state: 'running', reason: null }), true);
  assert.equal(rules.canTransition({ state: 'running', reason: null }, { state: 'failed', reason: 'output' }), true);
  assert.equal(rules.canTransition({ state: 'needs_review', reason: 'manager_lost' }, { state: 'succeeded', reason: null }), true);
  assert.equal(rules.canTransition({ state: 'needs_review', reason: 'conversation_busy' }, { state: 'succeeded', reason: null }), false);
  assert.equal(rules.canTransition({ state: 'queued', reason: null }, { state: 'failed', reason: 'output' }), false);
});

test('generic import faults recover to every observed outcome without weakening conversation contention',()=>{
  for(const reason of ['exit','timeout','launch','output','conversation_busy'] as const)
    assert.equal(rules.canTransition({state:'needs_review',reason:null},{state:'failed',reason}),true);
  assert.equal(rules.canTransition({state:'needs_review',reason:null},{state:'needs_review',reason:'conversation_busy'}),true);
  for(const reason of [null,'manager_lost'] as const){
    assert.equal(rules.canTransition({state:'needs_review',reason:'conversation_busy'},{state:'needs_review',reason}),false);
    assert.equal(rules.canTransition({state:'needs_review',reason:'conversation_busy'},{state:'failed',reason:'timeout'}),false);
  }
});
