/** Pure strict JSON decoding, independent of filesystem policy. */
export function strictJson(bytes: Uint8Array): unknown {
  const source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  let at = 0;
  const ws = () => { while (/\s/.test(source[at] ?? '') && at < source.length) at++; };
  const string = (): string => {
    const start = at++;
    while (at < source.length) {
      const c = source[at++];
      if (c === '\\') at++;
      else if (c === '"') return JSON.parse(source.slice(start, at));
    }
    throw new Error('Unterminated JSON string');
  };
  const value = (depth: number): void => {
    if (depth > 64) throw new Error('JSON nesting limit');
    ws();
    if (source[at] === '"') { string(); return; }
    const bracket = source[at];
    if (bracket === '{' || bracket === '[') {
      at++; ws(); const end = bracket === '{' ? '}' : ']', keys = new Set<string>();
      if (source[at] === end) { at++; return; }
      for (;;) {
        ws();
        if (bracket === '{') {
          if (source[at] !== '"') throw new Error('Expected JSON key');
          const key = string();
          if (keys.has(key)) throw new Error(`Duplicate JSON key: ${key}`);
          keys.add(key); ws(); if (source[at++] !== ':') throw new Error('Expected colon');
        }
        value(depth + 1); ws();
        const c = source[at++]; if (c === end) return;
        if (c !== ',') throw new Error('Expected comma');
      }
    }
    const start = at;
    while (at < source.length && !/[\s,\]}]/.test(source[at]!)) at++;
    if (at === start) throw new Error('Expected JSON value');
    JSON.parse(source.slice(start, at));
  };
  value(0); ws(); if (at !== source.length) throw new Error('Trailing JSON data');
  return JSON.parse(source);
}
