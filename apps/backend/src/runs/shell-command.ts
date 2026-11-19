/** Recognize one literal invocation, never execute or guess a shell program. */
import { cliCommands, cliCommandWords } from '@alpacawork/contract/cli-commands';
import { workCommandSchema, type WorkCommand } from '@alpacawork/contract/run';

const commands = cliCommands.map(spec => ({ words: cliCommandWords(spec), key: `${spec.group}.${spec.name}` }));

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

export function commandOf(value: unknown): WorkCommand | null {
  if (typeof value !== 'string' || value.length > 64 * 1024 || value.includes('\0')) return null;
  let words = literalWords(value);
  // Codex emits a single shell wrapper. Its script still goes through the same conservative recognizer.
  if (words?.length === 3 && /^(?:\/bin\/|\/usr\/bin\/)?(?:bash|sh)$/.test(words[0]!) && ['-c', '-lc'].includes(words[1]!))
    words = literalWords(words[2]!);
  if (!words || words[0] !== 'alpacawork' || words.some(word => word === '-h' || word === '--help')) return null;
  const found = commands.find(command => command.words.every((word, at) => words![at + 1] === word));
  const parsed = workCommandSchema.safeParse(found?.key);
  return parsed.success ? parsed.data : null;
}
