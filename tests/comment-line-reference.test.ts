/**
 * A comment may point at another file, but not at a line in it.
 *
 * Line numbers move whenever anything above them moves, and the comment that
 * quoted one does not move with them: it keeps pointing, silently, at whatever
 * has taken that line over. Rounds of repair removed the same kind of stale
 * pointer, and each round found more that the round before had missed. This is
 * the machine that stops the next one.
 *
 * The rule is the one written into the responsibility header of
 * `apps/web/src/styles.css`: point with a name (a class, a constant, an
 * export, a selector), never with a line number.
 *
 * What is forbidden is the shape `<name>.<ext>:<digit>` inside a comment.
 * Naming the file alone is fine, and so is a colon followed by anything but a
 * digit, which is how prose introduces a file.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const project = resolve(import.meta.dirname, '..');

/**
 * Scanned: every working-tree source file (tracked or newly added) whose comments are written as `//` and
 * `/* *\/` — the whole of `apps/`, `packages/`, `e2e/` and `tests/`. Product
 * code and test code are not told apart; stale pointers have sat in both.
 *
 * Not scanned, and why: `.json` has no comment syntax; `.md` is prose, not
 * comment, and is read as a document rather than as an aside to code; the one
 * `.html` and the three `.sql` files carry a third and fourth comment syntax
 * and no cross-file reference of any kind. Git-ignored additions and deleted
 * files are excluded, so dependencies and build output never enter.
 */
const SCANNED = new Set(['ts', 'tsx', 'js', 'mjs', 'cjs', 'css']);

/**
 * A URL carries its own colon-and-digits (`127.0.0.1:5481`) and its path may
 * end in a file name, so it is removed before the shape is looked for.
 */
const URL_IN_TEXT = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;
const LINE_REFERENCE = /[A-Za-z0-9_.-]*[A-Za-z0-9_-]\.(?:ts|tsx|css|js|mjs|cjs|json|sql|html|md):\d/g;

type Comment = { line: number; text: string };

/**
 * Comment text only. String literals and regular expressions are stepped over
 * whole, so a path written in code — a glob in a config, a fixture name in an
 * assertion — is never mistaken for a comment about one.
 */
export function comments(source: string, style: 'js' | 'css'): Comment[] {
  const found: Comment[] = [];
  let i = 0;
  let line = 1;
  let previous = '';
  const block = (): void => {
    const end = source.indexOf('*/', i + 2);
    const stop = end < 0 ? source.length : end + 2;
    const text = source.slice(i, stop);
    text.split('\n').forEach((part, offset) => found.push({ line: line + offset, text: part }));
    line += text.split('\n').length - 1;
    i = stop;
    previous = '/';
  };
  while (i < source.length) {
    const c = source[i];
    if (c === '\n') { line++; i++; continue; }
    if (c === '/' && source[i + 1] === '*') { block(); continue; }
    if (style === 'css') { i++; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      i++;
      while (i < source.length) {
        if (source[i] === '\\') { i += 2; continue; }
        if (source[i] === '\n') { line++; i++; if (quote !== '`') break; continue; }
        if (source[i] === quote) { i++; break; }
        i++;
      }
      previous = quote;
      continue;
    }
    if (c === '/' && source[i + 1] === '/') {
      let end = i;
      while (end < source.length && source[end] !== '\n') end++;
      found.push({ line, text: source.slice(i, end) });
      i = end;
      continue;
    }
    if (c === '/' && (previous === '' || '(,=:[!&|?{;+-*%~^'.includes(previous))) {
      i++;
      let inClass = false;
      while (i < source.length) {
        const d = source[i];
        if (d === '\\') { i += 2; continue; }
        if (d === '\n') break;
        if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) { i++; break; }
        i++;
      }
      while (i < source.length && /[gimsuyd]/.test(source[i]!)) i++;
      previous = '/';
      continue;
    }
    if (!/\s/.test(c!)) previous = c!;
    i++;
  }
  return found;
}

export function lineReferences(source: string, style: 'js' | 'css'): Comment[] {
  return comments(source, style).filter((c) => {
    LINE_REFERENCE.lastIndex = 0;
    return LINE_REFERENCE.test(c.text.replace(URL_IN_TEXT, ''));
  });
}

test('no comment points at another file by line number', () => {
  const deleted = new Set(execSync('git ls-files --deleted -z', { cwd: project, encoding: 'utf8' }).split('\0'));
  const files = execSync('git ls-files --cached --others --exclude-standard -z', { cwd: project, encoding: 'utf8' })
    .split('\0')
    .filter((f) => !deleted.has(f) && SCANNED.has(f.split('.').pop()!));
  assert.ok(files.length > 50, `expected the repository to be scanned, saw ${files.length} files`);
  const offenders: string[] = [];
  for (const file of files) {
    const style = file.endsWith('.css') ? 'css' : 'js';
    for (const hit of lineReferences(readFileSync(join(project, file), 'utf8'), style)) {
      offenders.push(`${file}:${hit.line}: ${hit.text.trim()}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `Refer to targets by name. Line numbers move and lose their meaning:\n${offenders.join('\n')}`,
  );
});

test('the check catches a line-number reference and nothing that merely looks like one', () => {
  const caught = (source: string, style: 'js' | 'css' = 'js'): number =>
    lineReferences(source, style).length;

  for (const source of [
    '// ' + 'styles.css:19' + ' maps --color-muted.',
    '/* ' + 'reading.css:483-497' + ' contains four rules */',
    'const a = 1; // see ' + 'button.tsx:17',
    '/**\n * ' + 'docs/i18n.md:19' + '\n */',
  ]) {
    assert.equal(caught(source), 1, `missed: ${source}`);
  }
  assert.equal(caught('/* ' + 'styles.css:19' + ' */', 'css'), 1);

  for (const [what, source] of [
    ['a file named without a line', '// the mechanism lives in styles.css, under @theme inline'],
    ['a colon introducing prose', '// vitest.config.ts: the third lane'],
    ['a URL with a port', '// served at http://127.0.0.1:5481/?design=j1'],
    ['a URL ending in a file and line', '// https://example.test/blob/main/app.ts:12'],
    ['a contrast ratio', '// colour is left to the variant (--input) so it stays >= 3:1.'],
    ['a contrast ratio in CSS', '/* Meets the 3:1 ratio of WCAG 1.4.11. At 56%, 2.67:1 falls short. */'],
    ['a port on a command line', '// and stop (`lsof -i :5493`).'],
    ['a clock time', '// the nightly run starts at 03:30 and holds the claim'],
    ['a version', '// Playwright 1.63.0 is pinned.'],
    ['a node: builtin', "// re-exported from node:test, not from test:9"],
    ['a file and line inside a string', 'const msg = "styles.css:19";'],
    ['a file and line inside a template', 'const msg = `see styles.css:19`;'],
    ['a file and line inside a regexp', 'const re = /styles\\.css:19/;'],
    ['a shell-style comment', '# styles.css:19'],
    ['an SQL-style comment', '-- styles.css:19'],
    ['a JSON glob', '{"include": ["apps/web/src/styles.css"]}'],
  ] as const) {
    const style = source.trimStart().startsWith('/*') ? 'css' : 'js';
    assert.equal(caught(source, style), 0, `false positive on ${what}: ${source}`);
  }
});
