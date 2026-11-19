import { CatalogUnavailable } from './files.js';
/** The declarative TOML subset used by supported Codex settings. Unsupported syntax fails closed. */
export function parseToml(text: string): Record<string, any> {
  let at = 0, depth = 0, nodes = 0;
  const headers = new WeakSet<object>();
  const root: Record<string, any> = Object.create(null); let table = root;
  const bad = (): never => { throw new CatalogUnavailable('settings'); };
  const space = () => { while (at < text.length) { if (/\s/.test(text[at]!)) at++; else if (text[at] === '#') { while (at < text.length && text[at] !== '\n') at++; } else break; } };
  const string = (): string => {
    const quote = text[at++], start = at; let escaped = false;
    while (at < text.length) {
      const char = text[at++];
      if (char === '\n') bad();
      if (char === quote && !escaped) { const raw = text.slice(start - 1, at); try { return quote === "'" ? raw.slice(1, -1) : JSON.parse(raw); } catch { return bad(); } }
      escaped = quote === '"' && char === '\\' && !escaped;
    }
    return bad();
  };
  const keys = (): string[] => {
    const path: string[] = [];
    do {
      while (text[at] === ' ' || text[at] === '\t') at++;
      if (text[at] === '"' || text[at] === "'") path.push(string());
      else { const m = /^[A-Za-z0-9_-]+/.exec(text.slice(at)); if (!m) bad(); path.push(m![0]); at += m![0].length; }
      while (text[at] === ' ' || text[at] === '\t') at++;
      if (text[at] !== '.') break; at++;
    } while (true);
    return path;
  };
  const target = (base: Record<string, any>, path: string[]) => {
    for (const key of path) {
      if (base[key] === undefined) base[key] = Object.create(null);
      base = Array.isArray(base[key]) ? base[key].at(-1) : base[key];
      if (!base || typeof base !== 'object') bad();
    }
    return base;
  };
  const set = (base: Record<string, any>, path: string[], value: unknown) => {
    const owner = target(base, path.slice(0, -1)), key = path.at(-1)!;
    if (Object.hasOwn(owner, key)) bad(); owner[key] = value;
  };
  const value = (): any => {
    if (++depth > 32 || ++nodes > 4096) throw new CatalogUnavailable('limit');
    try {
    space(); const char = text[at];
    if (char === '"' || char === "'") return string();
    if (char === '[') {
      at++; const list = []; space();
      while (text[at] !== ']') { list.push(value()); space(); if (text[at] !== ',') break; at++; space(); }
      if (text[at++] !== ']') bad(); return list;
    }
    if (char === '{') {
      at++; const object = Object.create(null); space();
      while (text[at] !== '}') { const path = keys(); if (text[at++] !== '=') bad(); set(object, path, value()); space(); if (text[at] !== ',') break; at++; space(); }
      if (text[at++] !== '}') bad(); return object;
    }
    const m = /^(true|false|[+-]?(?:0|[1-9](?:_?\d)*)(?:\.\d(?:_?\d)*)?)(?=[\s,\]}#]|$)/.exec(text.slice(at));
    if (!m) return bad(); at += m[0].length;
    return m[0] === 'true' ? true : m[0] === 'false' ? false : Number(m[0].replaceAll('_', ''));
    } finally { depth--; }
  };
  while (true) {
    space(); if (at >= text.length) break;
    if (text[at] === '[') {
      const array = text[++at] === '['; if (array) at++;
      const path = keys(); if (text[at++] !== ']' || array && text[at++] !== ']') bad();
      if (array) { const owner = target(root, path.slice(0, -1)), key = path.at(-1)!; owner[key] ??= []; if (!Array.isArray(owner[key])) bad(); table = Object.create(null); owner[key].push(table); }
      else { table = target(root, path); if (headers.has(table)) bad(); headers.add(table); }
    } else { const path = keys(); if (text[at++] !== '=') bad(); set(table, path, value()); }
    while (text[at] === ' ' || text[at] === '\t' || text[at] === '\r') at++;
    if (text[at] !== undefined && text[at] !== '\n' && text[at] !== '#') bad();
  }
  return root;
}
