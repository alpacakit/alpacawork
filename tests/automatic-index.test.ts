/** A read point's captured automatic-limit inputs, against the established stable-sort definition. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { automaticIndex, automaticLimitReached, type StoredRequest } from '@alpacawork/runs';
import { DELIVERY_STATE } from '@alpacawork/contract/control';

type Request = Pick<StoredRequest, 'taskId' | 'placementId' | 'purpose' | 'author' | 'deliveryState' | 'submittedAt'>;
const row = (fields: Partial<Request> = {}): Request => ({ taskId: 'T1', placementId: 'P1', purpose: 'instruction',
  author: { kind: 'placement', placementId: 'P0' }, deliveryState: 'queued', submittedAt: '2026-10-11T00:00:01Z', ...fields });
const user = (taskId = 'T1', submittedAt = '2026-10-11T00:00:02Z'): Request =>
  row({ taskId, submittedAt, author: { kind: 'human' } });
// Independent definition: stable-sort accepted rows, reset the total at each ancestry user Request, else count automatics.
function oracle(requests: readonly Request[], placement: string, ancestry: readonly string[]): number {
  let total = 0;
  for (const request of [...requests].sort((a, b) => a.submittedAt.localeCompare(b.submittedAt))) {
    if (request.deliveryState === 'aborted' || request.deliveryState === 'recorded_unconfirmed') continue;
    if ((request.author.kind === 'human' || request.author.kind === 'main') && ancestry.includes(request.taskId)) total = 0;
    else if (request.placementId === placement && (request.author.kind === 'placement' || request.purpose === 'return_continuation')) total++;
  }
  return total;
}

test('captured automatic counts match 30,000 stable-sort queries across unordered current Requests', () => {
  let seed = 442;
  const next = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>>= 0; };
  const times = ['2026-10-11T00:00:01Z', '2026-10-11T00:00:01.000Z', '2026-10-11T00:00:01+09:00',
    '2026-10-11T00:00:01-09:00', '2026-10-11T00:00:02Z'];
  const states = Object.values(DELIVERY_STATE);
  const authors: Request['author'][] = [{ kind: 'human' }, { kind: 'main', provider: 'codex', conversationId: 'C1' },
    { kind: 'main', provider: 'claude', conversationId: 'C2', quote: 'Go' }, { kind: 'placement', placementId: 'P0' }];
  const purposes: Request['purpose'][] = ['instruction', 'return_continuation', 'review_send_back'];
  for (let i = 0; i < 30_000; i++) {
    const rows = Array.from({ length: next() % 18 }, () => row({ taskId: `T${next() % 4}`, placementId: `P${next() % 4}`,
      author: authors[next() % authors.length]!, purpose: purposes[next() % purposes.length]!,
      deliveryState: states[next() % states.length]!, submittedAt: times[next() % times.length]! }));
    if (rows.length && i % 5 === 0) rows.push(rows[0]!); // object/identity repetition is still a distinct position
    const placement = `P${next() % 5}`, ancestry = Array.from({ length: next() % 5 }, () => `T${next() % 5}`);
    const expected = oracle(rows, placement, ancestry), captured = automaticIndex(rows);
    assert.equal(captured.count(placement, ancestry), expected, `captured query ${i}`);
    assert.equal(captured.reached(placement, ancestry, 2), expected >= 2);
    assert.equal(automaticLimitReached(rows, placement, ancestry, 2), expected >= 2);
  }
});

test('collation-equal distinct strings and cross-ancestor resets retain original positions, not query or Request identity order', () => {
  const time = '2026-10-11T00:00:01Z';
  const early = user('T0', time + '\u00e9'), late = user('T1', time + 'e\u0301');
  assert.notEqual(early.submittedAt, late.submittedAt);
  assert.equal(early.submittedAt.localeCompare(late.submittedAt), 0);
  const automatic = row({ submittedAt: early.submittedAt });
  const inputs = [early, automatic, late, automatic];
  for (const ancestry of [['T1', 'T0'], ['T0', 'T1'], ['T0', 'T1', 'T0']])
    assert.equal(automaticIndex(inputs).count('P1', ancestry), 1);
  const continuation = { ...late, purpose: 'return_continuation' as const };
  assert.equal(automaticIndex([automatic, continuation, automatic]).count('P1', ['T1']), 1, 'reset itself never counts');
  assert.equal(automaticIndex([automatic, continuation, automatic]).count('P1', ['T9']), 3, 'outside-ancestry user continuation still counts');
  assert.equal(automaticIndex([automatic, automatic, late]).count('P1', ['T1']), 0, 'duplicate object positions before reset stay before');
});

test('all delivery states and special limits retain the exact public comparison, and frozen inputs remain untouched', () => {
  for (const state of Object.values(DELIVERY_STATE)) {
    const request = Object.freeze(row({ deliveryState: state, author: Object.freeze({ kind: 'placement', placementId: 'P0' }) }));
    const requests = Object.freeze([request]), captured = automaticIndex(requests);
    const expected = state === 'aborted' || state === 'recorded_unconfirmed' ? 0 : 1;
    for (const limit of [0, -1, 0.5, 1, 2, NaN, Infinity, -Infinity]) {
      assert.equal(captured.reached('P1', ['T1'], limit), expected >= limit);
      assert.equal(automaticLimitReached(requests, 'P1', ['T1'], limit), expected >= limit);
    }
    assert.equal(captured.count('absent', []), 0);
    assert.equal(requests[0], request);
  }
});

test('captured primitive facts ignore later row, author and array changes; public and new captures read them afresh', () => {
  const scenarios: Array<[string, () => Request[], (requests: Request[]) => void]> = [
    ['timestamp', () => [row(), user()], items => { items[0]!.submittedAt = '2026-10-11T00:00:03Z'; }],
    ['reset Task', () => [row(), user()], items => { items[1]!.taskId = 'T9'; }],
    ['placement', () => [row()], items => { items[0]!.placementId = 'P2'; }],
    ['purpose', () => [row({ taskId: 'T9', purpose: 'return_continuation', author: { kind: 'human' } })], items => { items[0]!.purpose = 'instruction'; }],
    ['author', () => [row()], items => { Object.assign(items[0]!.author, { kind: 'human' }); }],
    ['aborted', () => [row()], items => { items[0]!.deliveryState = 'aborted'; }],
    ['unconfirmed', () => [row()], items => { items[0]!.deliveryState = 'recorded_unconfirmed'; }],
    ['push', () => [], items => { items.push(row()); }],
    ['splice', () => [row()], items => { items.splice(0, 1); }],
    ['reorder', () => [row(), user('T1', row().submittedAt)], items => { items.reverse(); }],
  ];
  for (const [name, make, mutate] of scenarios) {
    const requests = make(), before = oracle(requests, 'P1', ['T1']), captured = automaticIndex(requests);
    mutate(requests);
    const after = oracle(requests, 'P1', ['T1']);
    assert.notEqual(before, after, `${name} must alter the subject's result`);
    assert.equal(captured.count('P1', ['T1']), before, `${name}: fixed at capture`);
    assert.equal(automaticIndex(requests).count('P1', ['T1']), after, `${name}: new capture`);
    assert.equal(automaticLimitReached(requests, 'P1', ['T1'], 1), after >= 1, `${name}: public fresh limit`);
  }
  const ancestry = ['T1'], captured = automaticIndex([row(), user()]);
  assert.equal(captured.count('P1', ancestry), 0);
  ancestry[0] = 'T9';
  assert.equal(captured.count('P1', ancestry), 1, 'query ancestry is current input, not retained by an earlier query');
});

test('repeated seat queries read only captured groups instead of scanning or retaining the original Request rows', () => {
  let reads = 0;
  const requests = Array.from({ length: 1000 }, (_, i) => new Proxy(row({ placementId: `P${i % 100}` }), {
    get(target, key, receiver) { reads++; return Reflect.get(target, key, receiver); },
  }));
  const captured = automaticIndex(requests), atCapture = reads;
  for (let pass = 0; pass < 3; pass++) for (let i = 0; i < 100; i++)
    assert.equal(captured.count(`P${i}`, ['T1']), 10);
  assert.ok(atCapture > 0);
  assert.equal(reads, atCapture, 'query must not revisit mutable source rows');
});
