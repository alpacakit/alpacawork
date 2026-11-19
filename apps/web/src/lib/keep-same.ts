/** What was last held for each id, with the text it was compared by. */
export type Held<T> = Map<string, { text: string; value: T }>;

/**
 * Whether two reads hold the very same parts: the same keys, each the same value or an array of the same items. Read
 * data is never changed in place, so this says they are equal without writing either out; a part read again as a new
 * object says nothing, and the caller compares their text.
 */
export function sameParts(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const sameItems = (x: unknown, y: unknown) => x === y
    || Array.isArray(x) && Array.isArray(y) && x.length === y.length && x.every((item, at) => item === y[at]);
  if (Array.isArray(a) || Array.isArray(b)) return sameItems(a, b);
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>, keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && sameItems(left[key], right[key]));
}

/**
 * Values read again whose content did not change stay the objects they were, so what is drawn from them is not drawn
 * again. Returns them in the order given; `held` then holds exactly these. A value must be plain JSON data.
 */
export function keepSame<T>(held: Held<T>, entries: Iterable<readonly [string, T]>): T[] {
  const next: Held<T> = new Map(), values: T[] = [];
  for (const [id, value] of entries) {
    const before = held.get(id);
    const entry = before && sameParts(before.value, value) ? before : (text => before?.text === text ? before! : { text, value })(JSON.stringify(value));
    next.set(id, entry); values.push(entry.value);
  }
  held.clear();
  for (const [id, entry] of next) held.set(id, entry);
  return values;
}
