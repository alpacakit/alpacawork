import { fenceLines } from './markdown-fences.js';
import { markdownBlockEnds } from './markdown.js';

type Located = { command: string; after: number };
export type ReportDiffCommand = Located & (
  | { kind: 'compare'; directories: string[]; base: string; head: string; mergeBase: boolean; paths: string[]; notation: 'range' | 'parent' | 'pair';
      /** The versions compared as the command writes them (`main...t76/x`, `abc^!`, `a b`). */
      written: string }
  | { kind: 'unsupported' | 'invalid'; reason: string });

/** Quotes only group literal arguments. No expansion, process, or shell evaluation ever happens here. */
function words(source: string): { tokens: string[]; expansion: boolean; broken: boolean } {
  const tokens: string[] = [];
  let word = '', active = false, quote = '', expansion = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!;
    if (!quote && /[|;&<>]/.test(c)) {
      if ((c === '>' || c === '<') && /^\d+$/.test(word)) { word = ''; active = false; }
      break;
    }
    if (c === '\\' && quote !== "'") {
      if (i + 1 === source.length) return { tokens, expansion, broken: true };
      word += source[++i]; active = true; continue;
    }
    if (c === quote) { quote = ''; continue; }
    if (!quote && (c === "'" || c === '"')) { quote = c; active = true; continue; }
    if (quote !== "'" && (c === '$' || c === '`')) expansion = true;
    if (!quote && /\s/.test(c)) {
      if (active) tokens.push(word);
      word = ''; active = false;
    } else { word += c; active = true; }
  }
  if (active) tokens.push(word);
  return { tokens, expansion, broken: quote !== '' };
}

const changesMeaning = /^(?:--cached|--staged|--no-index|--merge-base|--git-dir|--work-tree|--namespace)(?:=|$)/;
const takesValue = new Set(['--output', '-O', '-S', '-G', '-U', '--unified', '--diff-filter', '--word-diff-regex',
  '--stat-width', '--stat-name-width', '--stat-count', '--inter-hunk-context', '--diff-algorithm', '--src-prefix', '--dst-prefix']);

function commandAt(command: string, after: number): ReportDiffCommand | null {
  command = command.trim().replace(/^\$\s+/, '');
  if (!/^git(?:\s|$)/.test(command)) return null;
  const { tokens, expansion, broken } = words(command);
  const located = { command, after };
  const unsupported = (reason: string): ReportDiffCommand => ({ ...located, kind: 'unsupported', reason });
  const invalid = (reason: string): ReportDiffCommand => ({ ...located, kind: 'invalid', reason });
  const directories: string[] = [];
  let at = 1, globalUnsupported = false;
  while (at < tokens.length && tokens[at] !== 'diff') {
    const option = tokens[at++]!;
    if (option === '-C' || option === '-c') {
      const value = tokens[at++];
      if (value === undefined) return tokens.includes('diff') ? invalid(`Missing ${option} argument`) : null;
      if (option === '-C') directories.push(value);
    } else if (option !== '--no-pager' && option !== '-P') globalUnsupported = true;
  }
  if (tokens[at++] !== 'diff') return null;
  if (globalUnsupported) return unsupported('Git global option is not supported; use git -C <repo> diff base..head');
  if (broken || expansion) return invalid('Use literal paths and revisions, without shell expansion or unclosed quotes');
  if (directories.some(path => !path || path.startsWith('~') || path.includes('\0')))
    return invalid('Write an existing literal repository path (no ~ expansion)');
  const revisions: string[] = [], paths: string[] = [];
  let range = false;
  for (; at < tokens.length; at++) {
    const token = tokens[at]!;
    if (token === '--') { paths.push(...tokens.slice(at + 1)); break; }
    if (changesMeaning.test(token)) return unsupported('This form does not compare two commits; use base..head');
    if (token.startsWith('-')) {
      if (token.includes('..') || token.endsWith('^!')) return invalid('A revision must not begin with -');
      if (takesValue.has(token)) at++;
      continue;
    }
    if (range) paths.push(token);
    else { revisions.push(token); range = token.includes('..') || token.endsWith('^!'); }
  }
  let base: string, head: string, mergeBase = false, notation: 'range' | 'parent' | 'pair';
  if (revisions.length === 1 && revisions[0]!.includes('..')) {
    notation = 'range';
    const match = /^(.*?)\.{2}(\.?)(.*?)$/.exec(revisions[0]!);
    if (!match || match[1]!.includes('..') || match[3]!.includes('..')) return invalid('Write one base..head or base...head range');
    base = match[1] || 'HEAD'; head = match[3] || 'HEAD'; mergeBase = match[2] === '.';
  } else if (revisions.length === 1 && revisions[0]!.endsWith('^!')) {
    notation = 'parent';
    head = revisions[0]!.slice(0, -2); base = `${head}^`;
    if (!head) return invalid('Write a revision before ^!');
  } else if (revisions.length === 2) { [base, head] = revisions as [string, string]; notation = 'pair'; }
  else return unsupported('Working-tree and combined diffs are not attached; write base..head');
  if ([base, head].some(revision => revision.startsWith('-') || revision.includes('\0')))
    return invalid('A revision must not begin with - or contain NUL');
  if (paths.some(path => path.includes('\0'))) return invalid('Paths must not contain NUL');
  return { ...located, kind: 'compare', directories, base, head, mergeBase, paths, notation, written: revisions.join(' ') };
}

/** One command as written (a code line), read as findDiffCommands reads it; null when it is no git diff. */
export const readDiffCommand = (command: string): ReportDiffCommand | null => commandAt(command, 0);

/** Commands in code only. Fences and inline-code rules match markdownLinks and the renderer. */
export function findDiffCommands(markdown: string): ReportDiffCommand[] {
  const ends = markdownBlockEnds(markdown), result: ReportDiffCommand[] = [];
  const after = (end: number) => ends.find(value => value >= end) ?? markdown.length;
  const append = (source: string, end: number) => { const found = commandAt(source, after(end)); if (found) result.push(found); };
  const fences = fenceLines();
  let fenced = false, offset = 0, continued = '', fenceStart = 0;
  for (const raw of markdown.split('\n')) {
    const line = raw.replace(/\r$/, ''), end = Math.min(markdown.length, offset + raw.length + 1), read = fences(line);
    if (read && 'edge' in read) {
      if (continued) { append(continued, end); continued = ''; }
      fenced = read.edge === 'open';
      if (fenced) fenceStart = result.length;
    } else if (read) {
      if (/\\$/.test(read.code)) continued += read.code.slice(0, -1) + ' ';
      else { append(continued + read.code, end); continued = ''; }
    } else for (const match of line.matchAll(/`([^`]+)`/g)) append(match[1]!, offset + match.index + match[0].length);
    offset = end;
  }
  if (continued) append(continued, markdown.length);
  if (fenced) for (let i = fenceStart; i < result.length; i++) {
    const found = result[i]!;
    if (found.kind === 'unsupported') continue;
    result[i] = { command: found.command, after: found.after, kind: 'invalid', reason: 'Close the fenced code block before attaching its diff' };
  }
  return result;
}
