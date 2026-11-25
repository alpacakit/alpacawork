/** Recognize shell invocations from text without executing them. */
import { commandCatalog } from '@alpacawork/contract/commands';
import { workCommandSchema, type WorkCommand } from '@alpacawork/contract/run';

const commands = commandCatalog.cliCommands.map(spec => ({ words: spec.words, key: spec.access }));

/** Literal words only. Expansion, control flow, pipelines and redirection are deliberately unknown. */
function literalWords(text: string): string[] | null {
  const words: string[] = [];
  let word = '', started = false, quote: "'" | '"' | null = null;
  const take = () => { if (started) words.push(word); word = ''; started = false; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote === "'") { if (c === quote) quote = null; else word += c; continue; }
    if (quote === '"') {
      if (c === quote) { quote = null; continue; }
      if (c === '$' || c === '`') return null;
      if (c === '\\') {
        const next = text[++i];
        if (next === undefined) return null;
        word += ['"', '\\', '$', '`'].includes(next) ? next : next === '\n' ? '' : `\\${next}`;
      } else word += c;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; started = true; continue; }
    if (c === '\\') {
      const next = text[++i];
      if (next === undefined) return null;
      if (next !== '\n') { word += next; started = true; }
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\n') {
      if (c === '\n' && text.slice(i).trim()) return null;
      take(); continue;
    }
    if (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) return null;
    // One quoted heredoc, at the end, is literal stdin data rather than another command.
    if (text.startsWith('<<', i)) {
      take();
      const header = /^<<[ \t]*'([A-Za-z_][A-Za-z_0-9]*)'[ \t]*\r?\n/.exec(text.slice(i));
      if (!header) return null;
      const rest = text.slice(i + header[0].length).split('\n');
      const end = rest.findIndex(line => line === header[1]);
      if (end < 0 || rest.slice(end + 1).some(line => line.trim())) return null;
      return words;
    }
    if (';&|(){}<>$`#*?[]~'.includes(c)) return null;
    word += c; started = true;
  }
  if (quote) return null;
  take();
  return words;
}

function shellText(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 * 1024 && !value.includes('\0');
}

function wrappedScript(words: string[] | null): string | null {
  // Codex emits a single shell wrapper around the original command.
  if (words?.length === 3 && /^(?:\/bin\/|\/usr\/bin\/)?(?:bash|sh)$/.test(words[0]!) && ['-c', '-lc'].includes(words[1]!))
    return words[2]!;
  return null;
}

export function literalInvocation(value: unknown): string[] | null {
  if (!shellText(value)) return null;
  const words = literalWords(value), script = wrappedScript(words);
  return script === null ? words : literalWords(script);
}

function afterHereDoc(text: string, offset: number, end: string, stripTabs: boolean): number | null {
  while (offset < text.length) {
    const newline = text.indexOf('\n', offset);
    const line = text.slice(offset, newline < 0 ? text.length : newline);
    offset = newline < 0 ? text.length : newline + 1;
    if ((stripTabs ? line.replace(/^\t+/, '') : line) === end) return offset;
  }
  return null;
}

const shellTokens = [
  /[ \t]+|#[^\n]*/,
  /(?<boundary>\r?\n|&&|\|\||[;|])/,
  /(?<redirect>\d*(?:&>>?|<<<|<<-?|>>|<>|<&|>&|>\||[<>]))/,
  /(?<word>(?:'[^']*'|"(?:(?:\\[\s\S])|[^"\\])*"|\\[\s\S]|[^\x00-\x20'"\\;&|<>()\x60])+)/,
].map(pattern => pattern.source).join('|');

/** Yield simple commands for usage tallies. Unknown words keep their position as null. */
export function* simpleInvocations(value: unknown): Generator<(string | null)[]> {
  if (!shellText(value)) return;
  const text = wrappedScript(literalWords(value)) ?? value;
  const token = new RegExp(shellTokens, 'y');
  let words: (string | null)[] = [], redirect: string | undefined;
  const hereDocs: { end: string; stripTabs: boolean }[] = [];
  while (token.lastIndex < text.length) {
    const match = token.exec(text);
    if (!match) return; // Do not read through unsupported shell syntax.
    const { boundary, redirect: operator, word } = match.groups!;
    if (boundary) {
      if (redirect) return;
      if (words.length) yield words;
      words = [];
      if (boundary.endsWith('\n')) {
        for (const { end, stripTabs } of hereDocs) {
          const offset = afterHereDoc(text, token.lastIndex, end, stripTabs);
          if (offset === null) return;
          token.lastIndex = offset;
        }
        hereDocs.length = 0;
      }
    } else if (operator) {
      if (redirect) return;
      redirect = operator;
    } else if (word !== undefined) {
      // Keep a home-relative path as written. The tally needs only its skill name.
      const parsed = literalWords(word.startsWith('~/') ? "'~'" + word.slice(1) : word);
      if (parsed?.length === 0) continue; // Escaped newline.
      if (!parsed && /\$\(|\x60/.test(word)) return;
      const argument = parsed?.[0] ?? null;
      if (!redirect) words.push(argument);
      else if (/^\d*<<-?$/.test(redirect)) {
        if (argument === null) return;
        hereDocs.push({ end: argument, stripTabs: redirect.endsWith('-') });
      }
      redirect = undefined;
    }
  }
  if (words.length && !redirect && !hereDocs.length) yield words;
}

export function commandOf(value: unknown): WorkCommand | null {
  const words = literalInvocation(value);
  if (!words || words[0] !== 'alpacawork' || words.some(word => word === '-h' || word === '--help')) return null;
  const found = commands.find(command => command.words.every((word, at) => words![at + 1] === word));
  const parsed = workCommandSchema.safeParse(found?.key);
  return parsed.success ? parsed.data : null;
}
