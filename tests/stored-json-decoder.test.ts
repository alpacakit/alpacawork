import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { storedJsonDecoder } from '@alpacawork/core';

const counted = <T extends z.ZodType>(schema: T) => {
  let calls = 0;
  return { parse: (value: unknown) => { calls++; return schema.parse(value) as z.output<T>; }, calls: () => calls };
};

test('a text its schema passed unchanged is read again without the schema, as fresh as ever', () => {
  const schema = counted(z.object({ a: z.number(), list: z.array(z.number()) }).strict());
  const decode = storedJsonDecoder(schema), text = '{"a":1,"list":[1]}';
  const first = decode('L1', text), second = decode('L1', text);
  assert.equal(schema.calls(), 1);
  assert.deepEqual(second, first);
  assert.notEqual(second, first, 'each read gets its own objects');
  second.list.push(2);
  assert.deepEqual(decode('L1', text).list, [1], 'what one reader changes no other reader sees');
});

test('a changed text is checked again, and a refused one is refused every time', () => {
  const schema = counted(z.object({ a: z.number() }).strict());
  const decode = storedJsonDecoder(schema);
  decode('L1', '{"a":1}');
  assert.deepEqual(decode('L1', '{"a":2}'), { a: 2 });
  assert.equal(schema.calls(), 2);
  assert.throws(() => decode('L1', '{"a":"x"}'));
  assert.throws(() => decode('L1', '{"a":"x"}'));
  assert.equal(schema.calls(), 4);
  assert.throws(() => decode('L2', 'not json'), SyntaxError);
});

test('a schema that changes what it reads is applied every time', () => {
  const stripping = counted(z.object({ a: z.number() }));
  const strip = storedJsonDecoder(stripping);
  assert.deepEqual(strip('L1', '{"a":1,"extra":true}'), { a: 1 });
  assert.deepEqual(strip('L1', '{"a":1,"extra":true}'), { a: 1 }, 'an unknown key stays dropped');
  assert.equal(stripping.calls(), 2);
  const defaulting = storedJsonDecoder(z.object({ a: z.number().default(7) }));
  assert.deepEqual(defaulting('L1', '{}'), { a: 7 });
  assert.deepEqual(defaulting('L1', '{}'), { a: 7 });
});

test('a row stored in another key order reads the same every time', () => {
  const schema = counted(z.object({ a: z.number(), b: z.number() }).strict());
  const decode = storedJsonDecoder(schema), text = '{"b":2,"a":1}';
  assert.equal(JSON.stringify(decode('L1', text)), '{"a":1,"b":2}');
  assert.equal(JSON.stringify(decode('L1', text)), '{"a":1,"b":2}');
  assert.equal(schema.calls(), 2);
});
