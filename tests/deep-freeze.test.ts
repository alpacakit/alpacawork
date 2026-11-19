import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deepFreeze } from '@alpacawork/core';

test('deep freezing preserves serialized values and checks children of external or inherited frozen parents', () => {
  const child = { value: 1 }, external = Object.freeze({ child });
  deepFreeze(external);
  assert.throws(() => { child.value = 2; }, TypeError);
  const inherited = Object.assign(Object.create(deepFreeze({ parent: true })), { own: { value: 1 } });
  deepFreeze(inherited);
  assert.throws(() => { inherited.own.value = 2; }, TypeError);
  const plain = { nested: [{ value: 3 }] }, before = JSON.stringify(plain);
  deepFreeze(plain);
  assert.equal(JSON.stringify(plain), before);
  assert.deepEqual(Reflect.ownKeys(plain), ['nested'], 'freezing adds no schema-visible keys');
  assert.deepEqual(plain, { nested: [{ value: 3 }] });
  const cyclic: { child?: unknown; value: number } = { value: 1 }; cyclic.child = cyclic;
  assert.equal(deepFreeze(cyclic), cyclic);
  assert.throws(() => { cyclic.value = 2; }, TypeError);
});
