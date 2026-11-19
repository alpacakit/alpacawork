/** Deep JSON proof and its pure serialization. No acquisition, storage binding or scope lives here. */
const frozenJson = new WeakSet<object>();
// Ordinary JSON needs only the original deep proof. Extra facts exist only for signed zero or null prototypes.
const unusualJson = new WeakMap<object, { negativeZeros: number; plain: boolean }>();
export const isReadDataImmutable = (data: unknown): boolean => !!data && typeof data === 'object' && frozenJson.has(data);
/** Undefined means a container; all other values have one shared JSON/finite rule. */
function scalarJson(value: unknown): boolean | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  return typeof value === 'object' ? undefined : false;
}
const negativeZerosIn = (value: unknown): number => typeof value === 'number' ? Number(Object.is(value, -0))
  : value && typeof value === 'object' ? (unusualJson.get(value)?.negativeZeros ?? 0) : 0;
/** Both callers register only after every child has the same deep JSON proof. */
function freezeProvenJson(value: object, negativeZeros: number, plain: boolean): true {
  Object.freeze(value); frozenJson.add(value);
  if (negativeZeros || !plain) unusualJson.set(value, { negativeZeros, plain });
  return true;
}
function plainJsonPrototype(proto: object | null, array: boolean): boolean {
  if (proto === null) return !array;
  if (proto === (array ? Array.prototype : Object.prototype)) return true;
  // IDB and test structured clones can come from another realm; accept its native
  // plain prototype, never a class or a custom prototype with the same own fields.
  const constructor = Object.getOwnPropertyDescriptor(proto, 'constructor')?.value;
  return typeof constructor === 'function' && constructor.prototype === proto
    && Function.prototype.toString.call(constructor) === Function.prototype.toString.call(array ? Array : Object)
    && (array ? Array.isArray(proto) && Object.getPrototypeOf(Object.getPrototypeOf(proto)) === null
      : Object.getPrototypeOf(proto) === null);
}
export function freezeReadJson(value: unknown, visiting = new WeakSet<object>()): boolean {
  const scalar = scalarJson(value);
  if (scalar !== undefined) return scalar;
  const object = value as object;
  if (frozenJson.has(object)) return true;
  if (visiting.has(object)) return false;
  const array = Array.isArray(value), proto = Object.getPrototypeOf(value);
  if (!plainJsonPrototype(proto, array)) return false;
  visiting.add(object);
  const keys = Reflect.ownKeys(object);
  let negativeZeros = 0, plain = proto !== null;
  for (const key of keys) {
    if (array && key === 'length') continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (typeof key !== 'string' || array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length) || !descriptor.enumerable || !('value' in descriptor) || !freezeReadJson(descriptor.value, visiting)) return false;
    const child = descriptor.value;
    negativeZeros += negativeZerosIn(child);
    if (child && typeof child === 'object') plain &&= unusualJson.get(child)?.plain !== false;
  }
  if (array && keys.length !== value.length + 1) return false;
  visiting.delete(object);
  return freezeProvenJson(object, negativeZeros, plain);
}

/** Only parseReadJson can supply this fresh native tree: no getters, holes, cycles or custom prototypes.
 * Return its signed-zero count, or undefined if invalid. */
function freezeParsedJson(value: unknown): number | undefined {
  const scalar = scalarJson(value);
  if (scalar !== undefined) return scalar ? Number(Object.is(value, -0)) : undefined;
  const object = value as Record<string, unknown>;
  let negativeZeros = 0;
  for (const key in object) if (Object.hasOwn(object, key)) {
    const child = object[key];
    const childNegativeZeros = freezeParsedJson(child);
    if (childNegativeZeros === undefined) return undefined;
    negativeZeros += childNegativeZeros;
  }
  freezeProvenJson(object, negativeZeros, true);
  return negativeZeros;
}
/** Closed string boundary. Undefined rejects nonfinite JSON numbers; syntax errors stay SyntaxErrors. */
export function parseReadJson(text: string): unknown {
  if (typeof text !== 'string') throw new TypeError('Read payload must be JSON text');
  const value: unknown = JSON.parse(text);
  return freezeParsedJson(value) !== undefined ? value : undefined;
}

export const readSize = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
type Payload = { text: string; bytes: number };
// A numeric size can follow immutable data without retaining a second copy of its body.
// Encoding already needed for bytes can serve a same-job save; text remains collectible while Query data stays alive.
const jsonMemo = new WeakMap<object, { bytes: number; payload?: WeakRef<Payload> }>();
/** JSON.stringify's native fast path for ordinary data; only signed zero needs a token writer. */
function signedJson(value: unknown): string {
  if (typeof value === 'number') return Object.is(value, -0) ? '-0' : JSON.stringify(value);
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(signedJson).join(',') + ']';
  return '{' + Object.keys(value).map(key => JSON.stringify(key) + ':' + signedJson((value as Record<string, unknown>)[key])).join(',') + '}';
}
/** One serialization/size rule. Size-only calls need native JSON's logical -0 normalization. */
function encode(data: unknown, knownBytes?: number, preserveZero = true): Payload {
  const negativeZeros = preserveZero ? negativeZerosIn(data) : 0;
  const text = negativeZeros ? signedJson(data) : JSON.stringify(data);
  // The historical logical budget counts JSON.stringify(-0) as the one-byte 0.
  return { text, bytes: knownBytes ?? new TextEncoder().encode(text).byteLength - negativeZeros };
}
/** Validate before encoding so JSON cannot silently drop accessors, holes, undefined or nonfinite numbers. */
export function readPayload(data: unknown): Payload {
  if (!freezeReadJson(data)) throw new TypeError('Read payload must be deep JSON');
  const object = data !== null && typeof data === 'object' ? data : undefined;
  const memo = object ? jsonMemo.get(object) : undefined, known = memo?.payload?.deref();
  if (known) return known;
  const payload = encode(data, memo?.bytes);
  if (object) jsonMemo.set(object, { bytes: payload.bytes, payload: new WeakRef(payload) });
  return payload;
}
function readJsonBytes(data: unknown): number {
  if (!isReadDataImmutable(data)) return readSize(data);
  const object = data as object, memo = jsonMemo.get(object);
  // Never dereference text just to read bytes: WeakRef.deref keeps it alive for this job.
  if (memo) return memo.bytes;
  const payload = encode(data, undefined, false);
  // Ordinary JSON is already the exact storage representation. Keep only a weak result, as readPayload does;
  // signed zero's normalized sizing text must never stand in for its lossless storage text.
  jsonMemo.set(object, { bytes: payload.bytes, ...(negativeZerosIn(data) === 0 ? { payload: new WeakRef(payload) } : {}) });
  return payload.bytes;
}
/** Equal readPayload texts, decided on the proven trees: shared subtrees cost nothing and no text is built. */
export function sameReadPayload(a: unknown, b: unknown): boolean {
  if (!freezeReadJson(a) || !freezeReadJson(b)) throw new TypeError('Read payload must be deep JSON');
  return sameProvenJson(a, b);
}
function sameProvenJson(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === (b as unknown[]).length && a.every((value, at) => sameProvenJson(value, (b as unknown[])[at]));
  const keys = Object.keys(a), other = Object.keys(b);
  return keys.length === other.length && keys.every((key, at) => key === other[at]
    && sameProvenJson((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}
/** JSON.parse yields ordinary objects. A null-prototype basis must take that cold path too. */
export function readPayloadMatches(data: unknown, text: string) {
  return isReadDataImmutable(data) && unusualJson.get(data as object)?.plain !== false && readPayload(data).text === text;
}
/** Exact logical JSON UTF8 bytes of a record containing data once, preserving undefined omission. */
export function readDataSize(data: unknown, record: (data: unknown) => unknown) {
  const bytes = readJsonBytes(data);
  return data === undefined ? readSize(record(data)) : readSize(record(null)) - 4 + bytes;
}
