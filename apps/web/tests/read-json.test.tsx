import { expect, test, vi } from 'vitest';
import { freezeReadJson, isReadDataImmutable, parseReadJson, readDataSize, readPayload, readPayloadMatches } from '../src/data/read-json';
import { reuseReadPayload } from '../src/data/read-model';
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

test('native parser closes its input boundary and shares deep freeze, finite and signed-zero proof rules', () => {
  const input = '{"__proto__":{"zero":-0},"list":[-0,0,"text -0 \\ud800 界😀",{"n":-0}],"constructor":null}';
  const data = parseReadJson(input) as any;
  const visit = (value: any) => { if (!value || typeof value !== 'object') return;
    expect(Object.isFrozen(value), 'every native container must be frozen').toBe(true);
    expect(isReadDataImmutable(value), 'native and generic callers share the same proof').toBe(true);
    expect(Object.getPrototypeOf(value)).toBe(Array.isArray(value) ? Array.prototype : Object.prototype);
    Object.values(value).forEach(visit);
  };
  visit(data); expect(Object.hasOwn(data, '__proto__')).toBe(true);
  expect(Object.is(data.__proto__.zero, -0)).toBe(true); expect(Object.is(data.list[0], -0)).toBe(true);
  expect(data.list[2]).toBe('text -0 \ud800 界😀');
  const encoded = readPayload(data), restored = JSON.parse(encoded.text);
  expect(Object.is(restored.__proto__.zero, -0), 'native proof preserves every signed-zero occurrence').toBe(true);
  expect(Object.is(restored.list[3].n, -0)).toBe(true); expect(encoded.bytes).toBe(bytes(data));
  expect(new TextEncoder().encode(encoded.text).byteLength - encoded.bytes).toBe(3);
  expect(readPayloadMatches(data, encoded.text)).toBe(true); expect(freezeReadJson(data)).toBe(true);
  for (const text of ['1e400', '-1e400', '[0,1e400]', '{"n":-1e400}', '{"__proto__":{"n":1e400}}'])
    expect(parseReadJson(text), 'native numbers must be finite').toBeUndefined();
  for (const text of ['null', 'false', '12', '"\\udfff"', '[]', '{}']) expect(parseReadJson(text)).toEqual(JSON.parse(text));
  expect(Object.is(parseReadJson('-0'), -0)).toBe(true);
  expect(() => parseReadJson('{broken')).toThrow(SyntaxError);
  const toString = vi.fn(() => '{}');
  expect(() => parseReadJson({ toString } as any)).toThrow('Read payload must be JSON text'); expect(toString).not.toHaveBeenCalled();
});

test('signed zero tokens round trip losslessly, without changing string contents or historical logical bytes', () => {
  const child = Object.assign(Object.create(null), { '-0': -0, quoted: '"-0" \\ -0 \n 界😀' });
  const data = { minus: -0, zero: 0, list: [-0, 0, '-0', child], again: child };
  const encoded = readPayload(data), parsed = JSON.parse(encoded.text);
  expect(Object.is(parsed.minus, -0)).toBe(true); expect(Object.is(parsed.zero, 0)).toBe(true);
  expect(Object.is(parsed.list[0], -0)).toBe(true); expect(Object.is(parsed.list[3]['-0'], -0)).toBe(true);
  expect(Object.is(parsed.again['-0'], -0)).toBe(true); expect(parsed.list[3].quoted).toBe(child.quoted);
  expect(encoded.bytes).toBe(bytes(data));
  expect(new TextEncoder().encode(encoded.text).byteLength - encoded.bytes).toBe(4);
  expect(readDataSize(data, data => ({ key: ['test'], data }))).toBe(bytes({ key: ['test'], data }));
  expect(readPayload(-0)).toEqual({ text: '-0', bytes: 1 });
  expect(readPayload(0)).toEqual({ text: '0', bytes: 1 });
});

test('ordinary JSON takes one native stringify and memoizes text and bytes by deep immutable identity', () => {
  const data = { text: '日本語😀"\\\n', list: [1, null, false] }; freezeReadJson(data);
  const stringify = vi.spyOn(JSON, 'stringify'), first = readPayload(data);
  expect(first.text).toBe('{"text":"日本語😀\\"\\\\\\n","list":[1,null,false]}');
  expect(readPayload(data)).toBe(first); expect(stringify.mock.calls.filter(([value]) => value === data)).toHaveLength(1);
  stringify.mockRestore();
  expect(first.bytes).toBe(bytes(data)); expect(Object.isFrozen(data.list)).toBe(true);
});

test.each([false, true])('budgeting and saving reuse ordinary JSON while preserving signed-zero text and logical bytes: signed=%s', signed => {
  const data = { text: '日本語😀 text -0', zero: signed ? -0 : 0 }, record = (data: unknown) => ({ data });
  const expected = bytes(record(data)), logicalText = JSON.stringify(data), logicalBytes = bytes(data);
  freezeReadJson(data);
  const stringify = vi.spyOn(JSON, 'stringify'), encode = vi.spyOn(TextEncoder.prototype, 'encode');
  try {
    expect(readDataSize(data, record)).toBe(expected);
    expect(readDataSize(data, record)).toBe(expected);
    expect(stringify.mock.calls.filter(([value]) => value === data)).toHaveLength(1);
    const payload = readPayload(data);
    expect(payload.bytes).toBe(logicalBytes);
    expect(Object.is(JSON.parse(payload.text).zero, -0)).toBe(signed);
    // Budgeting already produced ordinary payload text. Signed zero still needs the lossless token writer.
    expect(stringify.mock.calls.filter(([value]) => value === data)).toHaveLength(1);
    expect(encode.mock.calls.filter(([text]) => text === logicalText), 'logical bytes are measured once per immutable identity').toHaveLength(1);
  } finally { stringify.mockRestore(); encode.mockRestore(); }
});

test('text matching distinguishes signed zero, whitespace, key order, semantic keys and prototype proof', () => {
  const data = { a: -0, b: 'text -0' }; readPayload(data);
  expect(reuseReadPayload(['task', 'root', 'T1'], '{"a":-0,"b":"text -0"}', [{ key: ['task', 'root', 'T1'], data }])).toBe(data);
  for (const text of ['{"a":0,"b":"text -0"}', ' {"a":-0,"b":"text -0"}', '{"b":"text -0","a":-0}']) expect(readPayloadMatches(data, text)).toBe(false);
  const nullProto = Object.assign(Object.create(null), { a: -0 }); readPayload(nullProto);
  expect(readPayloadMatches(nullProto, '{"a":-0}')).toBe(false);
  const nested = { child: nullProto }; readPayload(nested); expect(readPayloadMatches(nested, '{"child":{"a":-0}}')).toBe(false);
  const shallow = Object.freeze({ a: -0 }); expect(isReadDataImmutable(shallow)).toBe(false); expect(readPayloadMatches(shallow, '{"a":-0}')).toBe(false);
});

test('deep proof refuses non-JSON without invoking getters or allowing stringify normalization', () => {
  const getter = vi.fn(() => 'secret'), accessor = Object.defineProperty({}, 'value', { enumerable: true, get: getter });
  const cycle: any = {}; cycle.self = cycle;
  const symbol = { [Symbol('x')]: 1 }, hidden = Object.defineProperty({}, 'x', { value: 1 });
  const custom = Object.setPrototypeOf({ value: 1 }, { custom: true });
  const extra: any[] = []; Object.assign(extra, { extra: true });
  for (const data of [undefined, Infinity, NaN, Symbol('x'), 1n, accessor, cycle, symbol, hidden, custom, extra, new Date(), [, 1], [undefined], { x: undefined }, { x: Infinity }, { x: NaN }, { x: 1n }, { x: Symbol('x') }, Object.setPrototypeOf([1], null)]) {
    expect(freezeReadJson(data)).toBe(false); expect(() => readPayload(data)).toThrow('Read payload must be deep JSON');
  }
  expect(getter).not.toHaveBeenCalled();
});

test.each([-1, 0, 1])('signed payload preserves the independent full-JSON logical 8MiB boundary at delta %s', delta => {
  const limit = 8 * 1024 * 1024, data = { zero: -0, padding: '' }, wrap = (data: unknown) => ({ control: { format: 14 }, slots: [{ data }] });
  data.padding = 'x'.repeat(limit + delta - bytes(wrap(data)));
  const encoded = readPayload(data);
  expect(readDataSize(data, wrap)).toBe(limit + delta); expect(bytes(wrap(data))).toBe(limit + delta);
  expect(new TextEncoder().encode(encoded.text).byteLength).toBe(encoded.bytes + 1);
});
