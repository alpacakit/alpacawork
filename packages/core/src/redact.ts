/**
 * Every surfaced diagnostic and stored observation is redacted before it can be retained or exposed.
 */
const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9._-]{10,}\b/g,
];

const REDACTED = '[redacted]';

/** What names a credential: a name ending in one of these, however its words are joined. */
const CREDENTIAL_NAME_ENDS = [
  ['api', 'key'],
  ['access', 'key'],
  ['private', 'key'],
  ['secret', 'key'],
  ['authorization'],
  ['pass', 'phrase'],
  ['pass', 'word'],
  ['passwd'],
  ['secret'],
  ['token'],
];
const NAME_CHARS = 'a-z0-9._-';
const CREDENTIAL_NAME = `[${NAME_CHARS}]*(?:${CREDENTIAL_NAME_ENDS.map(words => words.join('[ ._-]?')).join('|')})`;

const URL_CREDENTIAL = {
  // A scheme is the run of scheme characters from its first letter. Each run is tried once, from where it begins,
  // carrying the digits and +.- before that letter: trying again from every later position of a long run would take
  // time growing with its square. The authority ends at / ? or #, and a password may hold an @, so it runs to the last.
  pattern: /(?<![a-z0-9+.-])([0-9+.-]*)([a-z][a-z0-9+.-]*:\/\/)([^/?#\s:@]*):([^/?#\s]+)@/giu,
  replacement: `$1$2${REDACTED}@`,
};

/** A credential name and what separates it from its value, tried once from where each run of name characters begins. */
const CREDENTIAL_PAIR = new RegExp(`(?<![${NAME_CHARS}])(["'\`]?)${CREDENTIAL_NAME}\\1[ \\t]*(=>?(?!=)|:=?)[ \\t]*`, 'giu');
const QUOTES = '"\'`';
/** What follows a closing quote. A quote before anything else is part of the value: `'it's'`, broken as written. */
const AFTER_CLOSING_QUOTE = new Set([' ', '\t', ',', ';', ')', '}', ']']);
const JSON_LITERAL = /(?:-?\d+(?:\.\d+)?(?:e[-+]?\d+)?|true|false|null)(?=[\s,}\]]|$)/iuy;
const BLOCK_SCALAR_HEADER = /[|>][-+0-9]*\s*$/uy;
const ONLY_CLOSING_MARKS = /[\s,;)}\]]*$/uy;
/** A bare value ends at white space; marks closing what surrounds the assignment stay outside it. */
const BARE_VALUE = /\S*[^\s,;)}\]"'`]/uy;
const URL_PARAMETER_VALUE = /[^&#\s]*[^&#\s,;)}\]"'`]/uy;
/** After a comma in `{a: b, c: d}`: another member or the end, so the comma ends the value. Otherwise it is the value's own. */
const NEXT_FLOW_MEMBER = new RegExp(`[ \\t]*(?:["'\`]?[${NAME_CHARS}]+["'\`]?[ \\t]*[:=]|$)`, 'iuy');
/**
 * A YAML parser's error: one line naming the fault, then the source around it down to a line of carets alone. Its two
 * lines at most bound the scan from each candidate. Lines here end only at \n, as the parser wrote them: a line start
 * at \r or U+2028 would scan on across them from each.
 */
const YAML_ERROR = /(?<![^\n])([^\n]*?)( at line \d+, column \d+:\n\n)((?:[^\n]*\n){1,2}?)( *\^+)(?![^\n])/gu;
/** The parts of a fault's words that quote its source: `Not a YAML token: VALUE`, `escape sequence \VALUE`, `so !<VALUE> is`. */
const FAULT_QUOTE = /(?<=\S: ).*|(?<= )\\.*|(?<= )[!%]\S*/gsu;
/** A credential's name written in a YAML excerpt, with whatever separates it from what comes next. */
const EXCERPT_NAME = new RegExp(`(?<![${NAME_CHARS}])["'\`]?${CREDENTIAL_NAME}(?![${NAME_CHARS}])["'\`]?[ \\t]*(?:=>?|:=?|,)?[ \\t]*`, 'iu');

function matchAt(pattern: RegExp, line: string, at: number): string {
  pattern.lastIndex = at;
  return pattern.exec(line)?.[0] ?? '';
}

function quotedEnd(line: string, start: number): number {
  const quote = line[start];
  for (let at = start + 1; at < line.length; at += 1) {
    if (quote === '"' && line[at] === '\\') at += 1;
    else if (line[at] === quote && (at + 1 === line.length || AFTER_CLOSING_QUOTE.has(line[at + 1]!))) return at + 1;
  }
  return line.length;
}

function flowEnd(line: string, start: number): number {
  let end = start;
  while (end < line.length && !'{}[]'.includes(line[end]!)
    && !(line[end] === ',' && (NEXT_FLOW_MEMBER.lastIndex = end + 1, NEXT_FLOW_MEMBER.test(line)))) end += 1;
  return start + line.slice(start, end).trimEnd().length;
}

function nestedEnd(line: string, start: number): number {
  let depth = 0;
  for (let at = start; at < line.length; at += 1) {
    if (line[at] === '{' || line[at] === '[') depth += 1;
    else if ((line[at] === '}' || line[at] === ']') && --depth === 0) return at + 1;
  }
  return line.length;
}

/** The value's text as shown: a value's own quotes stay, so the line still reads as it was written. */
function hidden(value: string): string {
  const quote = QUOTES.includes(value[0]!) ? value[0]! : '';
  if (quote && value === quote + quote) return value;
  return `${quote}${REDACTED}${quote && value.length > 1 && value.endsWith(quote) ? quote : ''}`;
}

/** Where a value starting at `start` ends, by what surrounds it. Only a colon's value runs past white space. */
function valueEnd(line: string, start: number, place: { inFlow: boolean; colon: boolean; inUrl: boolean }): number {
  const first = line[start]!;
  if (line.startsWith(REDACTED, start)) return start + REDACTED.length;
  if (QUOTES.includes(first)) {
    const end = quotedEnd(line, start);
    return !place.inFlow && place.colon && matchAt(ONLY_CLOSING_MARKS, line, end).length !== line.length - end ? line.length : end;
  }
  if (place.inUrl) return start + matchAt(URL_PARAMETER_VALUE, line, start).length;
  if (!place.colon) return start + matchAt(BARE_VALUE, line, start).length;
  if (!place.inFlow) return line.length;
  if (first === '{' || first === '[') return nestedEnd(line, start);
  return flowEnd(line, start);
}

function redactLine(line: string): { text: string; opensValue: boolean } {
  const flowStart = line.search(/[{[]/u);
  const lineStart = /^[ \t]*(?:[-?][ \t]+)*/u.exec(line)![0].length;
  let text = '';
  let copied = 0;
  let opensValue = false;
  CREDENTIAL_PAIR.lastIndex = 0;
  for (let match = CREDENTIAL_PAIR.exec(line); match; match = CREDENTIAL_PAIR.exec(line)) {
    const [whole, keyQuote = '', separator = ''] = match;
    const start = match.index + whole.length;
    let before = match.index - 1;
    while (line[before] === ' ' || line[before] === '\t') before -= 1;
    const previous = line[before] ?? '';
    const inFlow = flowStart >= 0 && flowStart < match.index;
    const colon = separator.startsWith(':');
    // A colon mid-sentence is prose ("Invalid token: expected a string"), unless what follows is quoted like a value.
    if (colon && match.index !== lineStart && previous !== ';' && !(inFlow && /[{[,]/u.test(previous))
      && !QUOTES.includes(line[start] ?? ' ')) continue;
    if (start === line.length || matchAt(BLOCK_SCALAR_HEADER, line, start)) {
      opensValue ||= !inFlow;
      continue;
    }
    if (keyQuote && matchAt(JSON_LITERAL, line, start)) continue;
    const end = valueEnd(line, start, { inFlow, colon, inUrl: before === match.index - 1 && /[?&#]/u.test(previous) });
    if (end > start) {
      text += line.slice(copied, start) + hidden(line.slice(start, end));
      copied = end;
      CREDENTIAL_PAIR.lastIndex = end;
    }
  }
  return { text: text + line.slice(copied), opensValue };
}

/** Each line's pairs; a name with its value still to come takes the next line, and the deeper lines of a block value. */
function redactLines(text: string): string {
  const parts = text.split(/(\r\n?|\n)/u);
  let nameIndent = -1;
  let taking = false;
  let first = false;
  for (let index = 0; index < parts.length; index += 2) {
    const line = parts[index]!;
    const indent = /^[ \t]*/u.exec(line)![0].length;
    if (taking && line.trim()) {
      if (first || indent > nameIndent) {
        parts[index] = line.slice(0, indent) + REDACTED;
        taking = indent > nameIndent;
        first = false;
        continue;
      }
      taking = false;
    }
    const { text: redacted, opensValue } = redactLine(line);
    parts[index] = redacted;
    if (opensValue) {
      taking = true;
      first = true;
      nameIndent = indent;
    }
  }
  return parts.join('');
}

/**
 * An excerpt is configuration broken as written, so where one of its values ends cannot be read from it. From a
 * credential's name on, it is hidden whole. A line the parser cut at its start may have lost the name: hidden whole too.
 */
function redactExcerpt(excerpt: string): string {
  let hiding = false;
  return excerpt.split('\n').map((line) => {
    if (!line.trim()) return line;
    if (line.startsWith('…')) return `…${REDACTED}`;
    if (hiding) return line.slice(0, /^[ \t]*/u.exec(line)![0].length) + REDACTED;
    const name = EXCERPT_NAME.exec(line);
    if (!name) return line;
    hiding = true;
    const kept = name.index + name[0].length;
    return kept < line.trimEnd().length ? line.slice(0, kept) + REDACTED : line;
  }).join('\n');
}

/** The excerpt, and the fault's own words when they quote from a line that held a credential: `extra characters: VALUE`. */
function redactYamlError(_whole: string, fault: string, position: string, excerpt: string, caret: string): string {
  const redacted = redactExcerpt(excerpt);
  return `${redacted === excerpt ? fault : fault.replace(FAULT_QUOTE, REDACTED)}${position}${redacted}${caret}`;
}

export function redactSecrets(text: string): string {
  let redacted = text;
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, REDACTED);
  }
  redacted = redacted.replace(URL_CREDENTIAL.pattern, URL_CREDENTIAL.replacement);
  return redactLines(redacted.replace(YAML_ERROR, redactYamlError));
}
