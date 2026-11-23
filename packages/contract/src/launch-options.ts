/** Small argv grammar, deliberately not a shell. Quotes join fragments; backslashes are literal. */
import { isVariableName, isParamName, isSystemVariable, type SystemVariableName } from './agent-variables.js';
export type OptionPart = { kind: 'literal'; value: string } | { kind: 'selection'; name: string }
  | { kind: 'system'; name: SystemVariableName };
export type OptionWord = { kind: 'word'; parts: OptionPart[] };
export type OptionGroup = { kind: 'group'; words: OptionWord[] };
export type LaunchOptions = (OptionWord | OptionGroup)[];
export class InvalidLaunchOptions extends Error {
  readonly code = 'invalid_launch_options';
  constructor(readonly offset: number, message: string) { super(`${message} (offset ${offset})`); }
}
/** Draft reference discovery shares the lexer, but tolerates unfinished quotes/groups/braces. */
function lex(source: string, draft: boolean): { ast: LaunchOptions; references: string[] } {
  const ast: LaunchOptions = []; const references = new Set<string>();
  let group: OptionGroup | undefined; let word: OptionWord | undefined; let quote = '';
  const flush = () => { if (word) { (group ? group.words : ast).push(word); word = undefined; } };
  const literal = (value: string) => {
    word ??= { kind: 'word', parts: [] };
    const last = word.parts.at(-1);
    if (last?.kind === 'literal') last.value += value;
    else word.parts.push({ kind: 'literal', value });
  };
  for (let i = 0; i < source.length; i++) {
    const char = source[i]!;
    if (char === quote) { quote = ''; continue; }
    if (!quote && (char === '"' || char === "'")) { quote = char; literal(''); continue; }
    if (!quote && /\s/.test(char)) { flush(); continue; }
    if (!quote && (char === '[' || char === ']')) {
      flush();
      if (char === '[') {
        if (group) { if (!draft) throw new InvalidLaunchOptions(i, 'Nested groups are not supported'); }
        else { group = { kind: 'group', words: [] }; ast.push(group); }
      } else {
        if (!group && !draft) throw new InvalidLaunchOptions(i, 'Unexpected ]');
        group = undefined;
      }
      continue;
    }
    if (char === '{') {
      const end = source.indexOf('}', i + 1);
      if (end === -1) { if (!draft) throw new InvalidLaunchOptions(i, 'Unclosed reference'); break; }
      const name = source.slice(i + 1, end);
      if (!isVariableName(name)) { if (!draft) throw new InvalidLaunchOptions(i, 'Invalid variable name'); }
      else {
        references.add(name); word ??= { kind: 'word', parts: [] };
        word.parts.push(isSystemVariable(name) ? { kind: 'system', name } : { kind: 'selection', name });
      }
      i = end; continue;
    }
    if (char === '}' && !draft) throw new InvalidLaunchOptions(i, 'Unexpected }');
    literal(char);
  }
  if (quote && !draft) throw new InvalidLaunchOptions(source.length, 'Unclosed quote');
  if (group && !draft) throw new InvalidLaunchOptions(source.length, 'Unclosed group');
  flush();
  return { ast, references: [...references] };
}
export const parseLaunchOptions = (source: string): LaunchOptions => lex(source, false).ast;
export function completeOptionReferences(...sources: string[]): string[] {
  return [...new Set(sources.flatMap(source => lex(source, true).references))];
}
/** New draft rows only; deleting a reference never deletes the caller's existing params. */
export function missingOptionParams(params: Readonly<Record<string, unknown>>, ...sources: string[]): string[] {
  return completeOptionReferences(...sources).filter(name => isParamName(name) && !Object.hasOwn(params, name));
}
export function optionReferences(ast: LaunchOptions): { all: Set<string>; required: Set<string>; system: Set<SystemVariableName> } {
  const all = new Set<string>(); const required = new Set<string>(); const system = new Set<SystemVariableName>();
  for (const node of ast) for (const word of node.kind === 'word' ? [node] : node.words) for (const part of word.parts) {
    if (part.kind === 'system') system.add(part.name);
    else if (part.kind === 'selection') { all.add(part.name); if (node.kind === 'word') required.add(part.name); }
  }
  return { all, required, system };
}
export class MissingOptionValue extends Error {
  readonly code = 'missing_option_value';
  constructor(readonly variable: string, readonly source: 'selection' | 'system') { super(`Missing ${source} value: ${variable}`); }
}
/** Admission removes inactive groups but retains original references. Selected values are frozen
 * separately in launch.values. The manager substitutes BOTH namespaces together, exactly once.
 * availableSystem describes presence, never secret/runtime values; system values are supplied later.
 */
export function prepareLaunchOptions(ast: LaunchOptions, selection: Readonly<Record<string, string | null>>,
  availableSystem: readonly SystemVariableName[]): string[] {
  const available = new Set(availableSystem);
  const present = (part: Exclude<OptionPart, { kind: 'literal' }>) => part.kind === 'system' ? available.has(part.name) :
    Object.hasOwn(selection, part.name) && selection[part.name] != null && selection[part.name] !== '';
  const template = (word: OptionWord) => word.parts.map(part => part.kind === 'literal' ? part.value : '{' + part.name + '}').join('');
  return ast.flatMap(node => {
    if (node.kind === 'group') return node.words.some(word => word.parts.some(part => part.kind !== 'literal' && !present(part)))
      ? [] : node.words.map(template);
    for (const part of node.parts) if (part.kind !== 'literal' && !present(part)) throw new MissingOptionValue(part.name, part.kind);
    return [template(node)];
  });
}
const optionReference = /\{([a-z][a-z0-9_]*)\}/g;

/** Values used by the prepared options, after groups with missing values have been dropped. */
export function appliedLaunchValues(argv: readonly string[], effective: Readonly<Record<string, string | null>>) {
  const names = new Set(argv.flatMap(arg => Array.from(arg.matchAll(optionReference), match => match[1]!)));
  return Object.fromEntries(Object.entries(effective).filter(([key, value]) => value !== null && names.has(key)));
}

/** Consumes prepared original argv, never a previously substituted string. No tokenization or shell. */
export function resolveLaunchArgv(argv: readonly string[], selection: Readonly<Record<string, string | null>>,
  system: Readonly<Partial<Record<SystemVariableName, string>>>): string[] {
  return argv.map(arg => arg.replace(optionReference, (_match, name: string) => {
    const source = isSystemVariable(name) ? system : selection;
    const value = Object.hasOwn(source, name) ? source[name as keyof typeof source] : undefined;
    if (value == null || value === '') throw new MissingOptionValue(name, isSystemVariable(name) ? 'system' : 'selection');
    return value;
  }));
}
/** One-shot form of the same admission/execution operations, for previews and pure callers. */
export function resolveLaunchOptions(ast: LaunchOptions, selection: Readonly<Record<string, string | null>>,
  system: Readonly<Partial<Record<SystemVariableName, string>>>): string[] {
  const available = Object.entries(system).filter(([, value]) => value != null && value !== '').map(([name]) => name as SystemVariableName);
  return resolveLaunchArgv(prepareLaunchOptions(ast, selection, available), selection, system);
}
