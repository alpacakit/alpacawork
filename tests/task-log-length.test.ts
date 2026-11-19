import assert from 'node:assert/strict';
import { test } from 'node:test';
import { taskActorSchema, taskLogSchema, storedTaskLogSchema } from '@alpacawork/raw/task-log-schema';
import { MAX_DETAIL_LENGTH } from '@alpacawork/raw/values';

const log = (fields: Record<string, unknown> = {}) => ({
  id: 'L-length', kind: 'reported', at: '2026-10-27T00:00:00Z', title: null,
  description: null, actor: { kind: 'human' }, fromState: null, toState: null, ...fields,
});
const actor = (placementId: string) => ({ kind: 'placement', placementId });
const message = (limit: number) => `must be nonempty and at most ${limit} characters`;

test('Task actor limits count Unicode code points and retain the original words', () => {
  const valid = ['x'.repeat(128), '漢'.repeat(128), '😀'.repeat(128),
    'e\u0301'.repeat(64), '\ud800'.repeat(128), '\udc00'.repeat(128),
    'x'.repeat(126) + '\ud800\ud800', ' \twords\n ', '\u200b'];
  const invalid = ['', ' \t\r\n\u3000\ufeff', 'x'.repeat(129), '漢'.repeat(129),
    '😀'.repeat(129), 'e\u0301'.repeat(64) + 'x', '\ud800'.repeat(129),
    '\udc00'.repeat(129), 'x'.repeat(127) + '\ud800\ud800'];
  for (const placementId of valid)
    assert.deepEqual(taskActorSchema.parse(actor(placementId)), actor(placementId));
  for (const placementId of invalid) {
    const result = taskActorSchema.safeParse(actor(placementId));
    assert.equal(result.success, false, JSON.stringify(placementId));
    if (!result.success) assert.deepEqual(result.error.issues,
      [{ code: 'custom', path: ['placementId'], message: message(128) }]);
  }
});

test('Task log and stored log retain nullable descriptions and optional nonempty fields', () => {
  for (const schema of [taskLogSchema, storedTaskLogSchema]) {
    const absent = schema.parse(log());
    assert.equal(absent.description, null);
    assert.equal(Object.hasOwn(absent, 'originCauseId'), false);
    assert.equal(Object.hasOwn(schema.parse(log({ originCauseId: undefined })), 'originCauseId'), true);
    for (const value of ['a'.repeat(MAX_DETAIL_LENGTH), '😀'.repeat(MAX_DETAIL_LENGTH),
      '\ud800'.repeat(MAX_DETAIL_LENGTH), '  unchanged  ']) {
      assert.equal(schema.parse(log({ description: value })).description, value);
    }
    for (const description of ['', '\t \u3000', 'a'.repeat(MAX_DETAIL_LENGTH + 1),
      '😀'.repeat(MAX_DETAIL_LENGTH + 1), '\udc00'.repeat(MAX_DETAIL_LENGTH + 1)]) {
      const result = schema.safeParse(log({ description }));
      assert.equal(result.success, false);
      if (!result.success) assert.deepEqual(result.error.issues,
        [{ code: 'custom', path: ['description'], message: message(MAX_DETAIL_LENGTH) }]);
    }
    for (const originCauseId of ['x'.repeat(128), '😀'.repeat(128), '\ud800'.repeat(128)])
      assert.equal(schema.parse(log({ originCauseId })).originCauseId, originCauseId);
    for (const originCauseId of [null, '', ' ', '😀'.repeat(129)])
      assert.equal(schema.safeParse(log({ originCauseId })).success, false);
    assert.equal(schema.safeParse(log({ description: undefined })).success, false);
    assert.equal(schema.safeParse(log({ id: '😀'.repeat(128) })).success, true);
    assert.equal(schema.safeParse(log({ id: '😀'.repeat(129) })).success, false);
  }
});

test('Main actor quote, conversation and optional message keep their distinct limits', () => {
  const main = { kind: 'main', provider: 'codex', conversationId: '😀'.repeat(200) };
  assert.deepEqual(taskActorSchema.parse(main), main);
  assert.equal(taskActorSchema.safeParse({ ...main, conversationId: '😀'.repeat(201) }).success, false);
  assert.equal(taskActorSchema.safeParse({ ...main, quote: '😀'.repeat(1000), message: '\ud800'.repeat(128) }).success, true);
  for (const fields of [{ quote: null }, { quote: '' }, { quote: '😀'.repeat(1001) },
    { message: null }, { message: '\u3000' }, { message: '\ud800'.repeat(129) }])
    assert.equal(taskActorSchema.safeParse({ ...main, ...fields }).success, false);
});

test('Repeated short Task log validation avoids string enumeration but retains the Unicode fallback', () => {
  const id = 'L-short-words', description = 'A short history description', originCauseId = 'L-source';
  const short = log({ id, description, originCauseId });
  const astral = '😀'.repeat(128), tooLong = 'z'.repeat(129), blank = ' '.repeat(129);
  const watched = new Set([id, description, originCauseId, astral, tooLong, blank]);
  const counts = new Map<string, number>();
  const iterator = String.prototype[Symbol.iterator];
  String.prototype[Symbol.iterator] = function(this: string) {
    const value = String(this);
    if (watched.has(value)) counts.set(value, (counts.get(value) ?? 0) + 1);
    return iterator.call(this);
  };
  try {
    for (let i = 0; i < 100; i++) storedTaskLogSchema.parse(short);
    assert.equal([...counts.values()].reduce((sum, count) => sum + count, 0), 0,
      'short persisted history fields must not be enumerated on each validation');
    assert.equal(taskActorSchema.safeParse(actor(astral)).success, true);
    assert.equal(taskActorSchema.safeParse(actor(tooLong)).success, false);
    assert.equal(taskActorSchema.safeParse(actor(blank)).success, false);
    assert.equal(counts.get(astral), 1, 'code-unit overflow still counts Unicode code points');
    assert.equal(counts.get(tooLong), 1, 'the existing full-count rejection remains in the fallback');
    assert.equal(counts.get(blank) ?? 0, 0, 'blank rejection still precedes character counting');
  } finally {
    String.prototype[Symbol.iterator] = iterator;
  }
});
