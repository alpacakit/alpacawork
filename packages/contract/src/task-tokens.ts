import { parseTaskId } from '@alpacawork/raw/task-id';

const taskNumber = /[TtＴｔPpＰｐ][0-9０-９]+/;
const whitespace = /\s/;
const unsafePrefixCharacter = /[:?=#@]/;

const quotes: ReadonlyMap<string, string> = new Map([['「', '」'], ['『', '』'], ['“', '”'], ['"', '"'], ["'", "'"]]);

export const formatTask = (id: string, title: string) => `${id}（${title}）`;

/** A leading wire label is context for the statement, not its words. Read the same grammar the sender writes.
 * Titles in saved messages may differ from current task titles; the lexer consumes their opaque annotation.
 */
export function taskStatement(text: string, ownTask: string): string {
  if (!text.includes('（')) return text;
  const words = text.trimStart();
  const reference = taskTokens(words, id => ({ id, title: '' }))[0];
  if (!reference || reference.from !== 0 || words[reference.text.length] !== '（'
    || words[reference.to - 1] !== '）' || reference.to < words.length && !/\s/u.test(words[reference.to]!)) return text;
  return [reference.id === ownTask ? '' : reference.id, words.slice(reference.to).trimStart()].filter(Boolean).join(' ');
}

/** One source-order lexer for completion, send semantics and mention marks.
 * An opaque span owns its contents: quotes in task titles, or fences in quotes,
 * cannot change the meaning of the prose following that span.
 */
export function taskTokens(text: string, lookup: (id: string) => { id: string; title: string } | undefined) {
  return scanTaskTokens(text, lookup, false);
}

/** Resolve only the first eligible reference; later references are neither scanned nor looked up. */
export function firstTaskToken(text: string, lookup: (id: string) => { id: string; title: string } | undefined) {
  return scanTaskTokens(text, lookup, true)[0];
}

function scanTaskTokens(text: string, lookup: (id: string) => { id: string; title: string } | undefined, firstOnly: boolean) {
  const found: { id: string; title: string; from: number; to: number; text: string }[] = [];
  if (!taskNumber.test(text)) return found;
  const tokens = new RegExp(taskNumber.source, 'y');
  let cursor = 0, unsafePrefix = false;
  const skip = (end: number) => { cursor = end; unsafePrefix = false; };
  while (cursor < text.length) {
    if (cursor === 0 || text[cursor - 1] === '\n') {
      const next = text.indexOf('\n', cursor), end = next < 0 ? text.length : next + 1;
      const line = text.slice(cursor, end);
      const fence = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
      if (fence) {
        const close = new RegExp(`^[ \\t]{0,3}${fence[0]}{${fence.length},}[ \\t]*\\r?$`, 'gm');
        close.lastIndex = end;
        const match = close.exec(text);
        skip(match ? match.index + match[0].length : text.length);
        continue;
      }
      if (/^(?: {4}|\t|[ \t]*>)/.test(line)) { skip(end); continue; }
    }
    const character = text[cursor]!, quote = quotes.get(character);
    if (quote && !(character === "'" && /[A-Za-z0-9_]/.test(text[cursor - 1] ?? ''))) {
      const close = text.indexOf(quote, cursor + 1);
      skip(close < 0 ? text.length : close + quote.length);
      continue;
    }
    if (character === '`') {
      let end = cursor + 1;
      while (text[end] === '`') end++;
      const marker = text.slice(cursor, end), close = text.indexOf(marker, end);
      skip(close < 0 ? text.length : close + marker.length);
      continue;
    }
    if (character === '[') {
      const link = /^\[[^\]]*\]\([^)]*\)/.exec(text.slice(cursor));
      if (link) { skip(cursor + link[0].length); continue; }
    }
    if (text.startsWith('https://', cursor) || text.startsWith('http://', cursor) || text.startsWith('www.', cursor)) {
      let end = cursor;
      while (end < text.length && !whitespace.test(text[end]!)) end++;
      skip(end);
      continue;
    }
    tokens.lastIndex = cursor;
    const match = tokens.exec(text);
    if (match) {
      const from = cursor, to = from + match[0].length;
      const eligible = !(/[A-Za-z0-9_./\\:$#@-]/.test(text[from - 1] ?? '') || /[A-Za-z0-9_./\\:-]/.test(text[to] ?? '') ||
        unsafePrefix || /[?=#@]/.test(text[to] ?? ''));
      const normalized = match[0].normalize('NFKC').toUpperCase();
      const task = eligible && parseTaskId(normalized) ? lookup(normalized) : undefined;
      let end = to;
      if (text[to] === '（') {
        const title = task && formatTask(match[0], task.title);
        if (title && text.startsWith(title, from)) end = from + title.length;
        else {
          // Unknown or stale annotations are opaque too; their contents are not new targets.
          let depth = 1;
          end = to + 1;
          while (end < text.length && depth && text[end] !== '\n') {
            if (text[end] === '（') depth++;
            else if (text[end] === '）') depth--;
            end++;
          }
        }
      }
      // A project in prose needs its full wire label: bare P1/P2 can be review severities.
      const explicit = normalized[0] !== 'P' || text[to] === '（' && end > to + 2 && text[end - 1] === '）';
      if (task && explicit) {
        found.push({ id: task.id, title: task.title, from, to: end, text: match[0] });
        if (firstOnly) return found;
      }
      cursor = end;
      continue;
    }
    if (whitespace.test(character)) unsafePrefix = false;
    else if (unsafePrefixCharacter.test(character)) unsafePrefix = true;
    cursor++;
  }
  return found;
}
