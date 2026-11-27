import { isBuiltin, stripTypeScriptTypes } from 'node:module';
import { posix } from 'node:path';
import { parse, type ParseError } from '@babel/parser';
import { Problem, PROBLEM_CODE, type Issue } from '@alpacawork/core';
import { AUTOMATION_BUNDLE_LIMITS, isAutomationBundlePath } from '@alpacawork/contract/automation-program';

export type BundleSource = { path: string; source: string };
export type BundleDoc = {
  summary: string;
  body: string;
  params: { name: string; text: string }[];
  returns: string | null;
  throws: string[];
};
type ConfigPath = readonly PropertyKey[];
type Report = (field: string, line: number, message: string) => void;
type ConfigLine = (path: ConfigPath) => number;
type ValidateConfig = (value: unknown, file: string, line: ConfigLine) => readonly Issue[];
type Script = ReturnType<typeof parse>;
type Statement = Script['program']['body'][number];
type Expression = Extract<Statement, { type: 'ExpressionStatement' }>['expression'];
type Anchor = Pick<Statement, 'leadingComments' | 'loc' | 'start'>;
type FunctionNode = Extract<Statement, { type: 'FunctionDeclaration' }> |
  Extract<Expression, { type: 'FunctionExpression' | 'ArrowFunctionExpression' }>;
type AiUse = 'ai.ask' | 'tasks.create';
type Module = BundleSource & { script: Script; report: Report };
type Binding = { kind: 'value'; expression: Expression | null; constant: boolean; anchor: Anchor }
  | { kind: 'function'; node: Extract<Statement, { type: 'FunctionDeclaration' }>; anchor: Anchor }
  | { kind: 'import'; source: string; name: string; anchor: Anchor };
type Export = { name: string; local: string | null; source?: string; anchor: Anchor };
type Names = { bindings: Map<string, Binding>; exports: Export[]; starExports: Export[] };

const { entry, files: maxFiles, fileBytes, totalBytes } = AUTOMATION_BUNDLE_LIMITS;
const lineOf = (node: Pick<Anchor, 'loc'> | null | undefined) => node?.loc?.start.line ?? 1;
const badPathCharacters = /[\\\x00-\x1f\x7f:%?#]/;
const configField = (path: ConfigPath) => ['config', ...path].map(String).join('.');
const pathKey = (path: ConfigPath) => JSON.stringify(path.map(String));

function relativeImport(source: string, from: string): string | null {
  if ((!source.startsWith('./') && !source.startsWith('../')) || badPathCharacters.test(source)) return null;
  const resolved = posix.normalize(posix.join(posix.dirname(from), source));
  return isAutomationBundlePath(resolved) ? resolved : null;
}

function parseScript(file: BundleSource, report: Report): Module | null {
  const typed = /\.m?ts$/.test(file.path);
  try {
    const script = parse(file.source, {
      sourceType: 'module',
      plugins: typed ? ['typescript'] : [],
      createImportExpressions: true,
      errorRecovery: true,
    });
    for (const error of script.errors ?? []) report('source', error.loc.line, 'Fix the module syntax');
    if (typed && !script.errors?.length) {
      try { stripTypeScriptTypes(file.source); }
      catch (error) {
        const location = error instanceof SyntaxError ? /^:(\d+)\n/.exec(error.stack ?? '') : null;
        report('source', location ? Number(location[1]) : 1, 'Use TypeScript syntax that Node.js can erase');
      }
    }
    return { ...file, script, report };
  } catch (error) {
    const parseError = error as Partial<ParseError>;
    report('source', parseError.loc?.line ?? 1, 'Fix the module syntax');
    return null;
  }
}

function validateImports(module: Module, paths: ReadonlySet<string>, parts: Set<string>): void {
  const check = (source: string | undefined, line: number, typeOnly = false) => {
    if (source === 'alpacawork' && typeOnly) return;
    if (source?.startsWith('node:') && isBuiltin(source)) {
      if (!typeOnly) parts.add(source);
      return;
    }
    const path = source === undefined ? null : relativeImport(source, module.path);
    if (path === null) {
      module.report('import', line, 'Use a bundled relative path with an extension or a node: built-in');
    } else if (!paths.has(path)) {
      module.report('import', line, 'Add the referenced file to the bundle or correct the relative path');
    }
  };

  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value !== 'object' || value === null || !('type' in value)) return;
    const node = value as {
      type: string; loc?: Anchor['loc'];
      source?: { type: string; value?: string; expressions?: unknown[]; quasis?: { value: { cooked: string | null } }[] } | null;
      importKind?: string; exportKind?: string;
      argument?: { type: string; value?: string };
    };

    switch (node.type) {
      case 'ImportDeclaration':
      case 'ExportNamedDeclaration':
      case 'ExportAllDeclaration': {
        if (!node.source) break;
        // A declaration with only inline type specifiers is still a runtime side-effect import after stripping.
        check(node.source.value, lineOf(node), node.importKind === 'type' || node.exportKind === 'type');
        break;
      }
      case 'ImportExpression': {
        const source = node.source?.type === 'StringLiteral' ? node.source.value
          : node.source?.type === 'TemplateLiteral' && node.source.expressions?.length === 0
            ? node.source.quasis?.[0]?.value.cooked ?? undefined : undefined;
        check(source, lineOf(node));
        break;
      }
      case 'TSImportType':
        check(node.argument?.value, lineOf(node), true);
        break;
    }
    for (const child of Object.values(node)) visit(child);
  };
  visit(module.script.program);
}

const named = (node: { name: string } | { value: string }) => 'name' in node ? node.name : node.value;

function moduleNames(module: Module): Names {
  const bindings = new Map<string, Binding>(), exports: Export[] = [], starExports: Export[] = [];
  for (const node of module.script.program.body) {
    if (node.type === 'ImportDeclaration' && node.importKind !== 'type') {
      for (const specifier of node.specifiers) {
        if (specifier.type === 'ImportSpecifier' && specifier.importKind !== 'type')
          bindings.set(specifier.local.name, { kind: 'import', source: node.source.value, name: named(specifier.imported), anchor: node });
        else if (specifier.type === 'ImportDefaultSpecifier')
          bindings.set(specifier.local.name, { kind: 'import', source: node.source.value, name: 'default', anchor: node });
      }
      continue;
    }
    if (node.type === 'ExportAllDeclaration' && node.exportKind !== 'type') {
      starExports.push({ name: '*', local: null, source: node.source.value, anchor: node });
      continue;
    }
    if (node.type === 'ExportNamedDeclaration' && node.exportKind !== 'type') {
      for (const specifier of node.specifiers) {
        if (specifier.type === 'ExportSpecifier' && specifier.exportKind !== 'type')
          exports.push({ name: named(specifier.exported), local: named(specifier.local), source: node.source?.value, anchor: node });
        else if (specifier.type === 'ExportNamespaceSpecifier')
          exports.push({ name: named(specifier.exported), local: null, source: node.source?.value, anchor: node });
      }
    }
    const direct = node.type === 'ExportNamedDeclaration' && node.exportKind !== 'type';
    const declaration = node.type === 'ExportNamedDeclaration' || node.type === 'ExportDefaultDeclaration' ? node.declaration : node;
    if (declaration?.type === 'FunctionDeclaration' && declaration.id && !declaration.generator) {
      const local = declaration.id.name;
      bindings.set(local, { kind: 'function', node: declaration, anchor: node });
      if (direct) exports.push({ name: local, local, anchor: node });
      if (node.type === 'ExportDefaultDeclaration') exports.push({ name: 'default', local, anchor: node });
    } else if (declaration?.type === 'VariableDeclaration') {
      for (const item of declaration.declarations) {
        const name = item.id.type === 'Identifier' ? item.id.name : null;
        if (name !== null) bindings.set(name, { kind: 'value', expression: item.init ?? null,
          constant: declaration.kind === 'const', anchor: node });
        if (direct) exports.push({ name: name ?? '(destructured export)', local: name, anchor: node });
      }
    } else if (direct && declaration) {
      const name = 'id' in declaration && declaration.id?.type === 'Identifier' ? declaration.id.name : '(export)';
      exports.push({ name, local: name, anchor: node });
    } else if (node.type === 'ExportDefaultDeclaration') {
      const local = declaration?.type === 'Identifier' ? declaration.name : 'default';
      if (declaration?.type === 'FunctionDeclaration' && !declaration.generator)
        bindings.set(local, { kind: 'function', node: declaration, anchor: node });
      else if (declaration?.type === 'FunctionExpression' || declaration?.type === 'ArrowFunctionExpression')
        bindings.set(local, { kind: 'value', expression: declaration, constant: true, anchor: node });
      exports.push({ name: 'default', local, anchor: node });
    }
  }
  return { bindings, exports, starExports };
}

type Location = { module: Module; binding: Binding };
function findBinding(modules: ReadonlyMap<string, Module>, names: ReadonlyMap<string, Names>,
  module: Module, exported: Export, visited = new Set<string>()): Location | null {
  const { local } = exported;
  if (local === null) return null;
  const key = `${module.path}\0${exported.name}`;
  if (visited.has(key)) return null;
  visited.add(key);
  const localBinding = exported.source === undefined ? names.get(module.path)?.bindings.get(local) : undefined;
  if (localBinding && localBinding.kind !== 'import') return { module, binding: localBinding };
  const target = exported.source ?? (localBinding?.kind === 'import' ? localBinding.source : null);
  const targetName = localBinding?.kind === 'import' ? localBinding.name : local;
  const path = target === null ? null : relativeImport(target, module.path);
  if (path === null) return null;
  const targetModule = modules.get(path), targetNames = names.get(path);
  const next = targetNames?.exports.find(item => item.name === targetName);
  if (targetModule && next) return findBinding(modules, names, targetModule, next, visited);
  if (!targetModule || targetName === 'default') return null;
  let match: Location | null = null;
  for (const star of targetNames?.starExports ?? []) {
    const binding = findBinding(modules, names, targetModule, { ...star, name: targetName, local: targetName }, new Set(visited));
    if (!binding) continue;
    if (match && match.binding !== binding.binding) return null;
    match = binding;
  }
  return match;
}

function readConfig(node: Expression | null, path: ConfigPath, report: Report, lines: Map<string, number>): unknown {
  const line = lineOf(node);
  lines.set(pathKey(path), line);
  switch (node?.type) {
    case 'TSSatisfiesExpression':
      return readConfig(node.expression, path, report, lines);
    case 'NullLiteral':
      return null;
    case 'BooleanLiteral':
    case 'StringLiteral':
      return node.value;
    case 'NumericLiteral':
      if (Number.isFinite(node.value)) return node.value;
      break;
    case 'UnaryExpression':
      if (node.operator === '-' && node.argument.type === 'NumericLiteral' && Number.isFinite(node.argument.value)) return -node.argument.value;
      break;
    case 'ArrayExpression':
      return node.elements.map((item, index) => {
        const field = [...path, index];
        if (item && item.type !== 'SpreadElement') return readConfig(item, field, report, lines);
        report(configField(field), item ? lineOf(item) : line, 'Replace the spread or empty slot with a literal value');
        return undefined;
      });
    case 'ObjectExpression': {
      const entries = new Map<string, unknown>();
      for (const item of node.properties) {
        if (item.type !== 'ObjectProperty' || item.computed || item.shorthand) {
          report(configField(path), lineOf(item), 'Write a named field with a literal value');
          continue;
        }
        const key = item.key.type === 'Identifier' ? item.key.name
          : item.key.type === 'StringLiteral' || item.key.type === 'NumericLiteral' ? String(item.key.value) : null;
        if (key === null || key === '__proto__' || item.value.type === 'AssignmentPattern' || item.value.type === 'ArrayPattern' ||
            item.value.type === 'ObjectPattern' || item.value.type === 'RestElement' || item.value.type === 'VoidPattern') {
          report(configField(path), lineOf(item), 'Write a named field with a literal value');
          continue;
        }
        const field = [...path, key];
        if (entries.has(key)) report(configField(field), lineOf(item), 'Keep one value for each field');
        entries.set(key, readConfig(item.value, field, report, lines));
      }
      return Object.fromEntries(entries);
    }
  }
  report(configField(path), line, 'Use a literal value or satisfies with a literal value');
  return undefined;
}

function readDoc(module: Module, anchor: Anchor, name: string): BundleDoc | null {
  const comment = anchor.leadingComments?.at(-1), line = lineOf(anchor);
  if (comment?.type !== 'CommentBlock' || !comment.value.startsWith('*') ||
      module.source.slice(comment.end ?? 0, anchor.start ?? 0).trim() !== '') {
    module.report(name, line, 'Add a JSDoc summary directly before this function');
    return null;
  }
  const lines = comment.value.slice(1).split(/\r?\n/).map(value => value.replace(/^\s*\* ?/, '').trimEnd());
  while (lines[0]?.trim() === '') lines.shift();
  const summary = lines.shift()?.trim() ?? '';
  if (!summary || summary.startsWith('@') || [...summary].length > 80)
    module.report(name, lineOf(comment), 'Write a JSDoc summary of 1 to 80 characters');

  const body: string[] = [], tags: { kind: string; lines: string[] }[] = [];
  for (const text of lines) {
    const tag = /^\s*@(\w+)(?:\s+(.*))?$/.exec(text);
    if (tag) tags.push({ kind: tag[1]!, lines: [tag[2] ?? ''] });
    else (tags.at(-1)?.lines ?? body).push(text);
  }
  const doc: BundleDoc = { summary, body: body.join('\n').trim(), params: [], returns: null, throws: [] };
  for (const { kind, lines: content } of tags) {
    const text = content.join('\n').trim();
    if (kind === 'param') {
      const param = /^(?:\{[^}]+\}\s+)?(\S+)(?:[\t ]+-)?\s*([\s\S]*)$/.exec(text);
      if (param) doc.params.push({ name: param[1]!, text: param[2]!.trim() });
      else module.report(name, lineOf(comment), 'Write a parameter name after @param');
    } else if (kind === 'returns' && doc.returns === null) doc.returns = text;
    else if (kind === 'throws') doc.throws.push(text);
    else module.report(name, lineOf(comment), 'Use only @param, one @returns, and @throws in JSDoc');
  }
  return doc;
}

type SourceNode = {
  type: string; name?: string; value?: unknown; computed?: boolean; key?: SourceNode;
  callee?: SourceNode; object?: SourceNode; property?: SourceNode; arguments?: SourceNode[]; properties?: SourceNode[];
  id?: SourceNode; left?: SourceNode; argument?: SourceNode; param?: SourceNode; params?: SourceNode[];
  elements?: (SourceNode | null)[]; expression?: SourceNode;
  kind?: string; declarations?: SourceNode[]; init?: SourceNode; specifiers?: SourceNode[]; local?: SourceNode; importKind?: string; declare?: boolean;
};
const propertyName = (node: SourceNode) => node.computed ? undefined
  : node.key?.type === 'Identifier' ? node.key.name : node.key?.type === 'StringLiteral' ? node.key.value : undefined;

function bindsName(node: SourceNode | null | undefined, name: string): boolean {
  switch (node?.type) {
    case 'Identifier': return node.name === name;
    case 'ArrayPattern': return node.elements?.some(item => bindsName(item, name)) ?? false;
    case 'ObjectPattern': return node.properties?.some(item => bindsName(item, name)) ?? false;
    case 'ObjectProperty': return bindsName(node.value as SourceNode, name);
    case 'AssignmentPattern': return bindsName(node.left, name);
    case 'RestElement': return bindsName(node.argument, name);
    case 'TSAsExpression': case 'TSNonNullExpression': case 'TSTypeAssertion': case 'TSSatisfiesExpression':
      return bindsName(node.expression, name);
    default: return false;
  }
}

function changesSdkBinding(node: SourceNode, name: string): boolean {
  switch (node.type) {
    case 'VariableDeclarator': case 'ClassExpression': case 'ClassDeclaration':
      return bindsName(node.id, name);
    case 'FunctionExpression': case 'FunctionDeclaration': case 'ArrowFunctionExpression':
    case 'ObjectMethod': case 'ClassMethod': case 'ClassPrivateMethod':
      return bindsName(node.id, name) || (node.params?.some(param => bindsName(param, name)) ?? false);
    case 'CatchClause': return bindsName(node.param, name);
    case 'AssignmentExpression': case 'ForInStatement': case 'ForOfStatement': return bindsName(node.left, name);
    case 'UpdateExpression': return bindsName(node.argument, name);
    case 'CallExpression': return node.callee?.type === 'Identifier' && node.callee.name === 'eval';
    default: return false;
  }
}

const functionNodes = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression',
  'ObjectMethod', 'ClassMethod', 'ClassPrivateMethod', 'StaticBlock']);
const blockNodes = new Set(['BlockStatement', 'CatchClause', 'ClassExpression', 'SwitchStatement',
  'ForStatement', 'ForOfStatement', 'ForInStatement']);

const erasedExpressions = new Set(['TSAsExpression', 'TSNonNullExpression', 'TSTypeAssertion',
  'TSSatisfiesExpression', 'TSInstantiationExpression', 'ParenthesizedExpression']);
function sourceValue(node: SourceNode | undefined): SourceNode | undefined {
  while (node && erasedExpressions.has(node.type)) node = node.expression;
  return node;
}
function globalFetchHost(node: SourceNode | undefined) {
  const value = sourceValue(node);
  return value?.type === 'Identifier' && (value.name === 'globalThis' || value.name === 'global') ? value.name : undefined;
}

function callsGlobalFetch(program: Script['program']): boolean {
  const names = ['fetch', 'globalThis', 'global'] as const;
  type Name = (typeof names)[number];
  type Reference = { name: Name; scope: Scope };
  type Scope = { parent: Scope | null; functionScope: boolean; bindings: Map<Name, Reference | null> };
  const calls: Reference[] = [];
  const remember = (scope: Scope, binding: SourceNode | undefined) => {
    for (const name of names) if (bindsName(binding, name)) scope.bindings.set(name, null);
  };
  const localFunction = (scope: Scope): Scope => {
    while (!scope.functionScope && scope.parent) scope = scope.parent;
    return scope;
  };
  function visit(value: unknown, scope: Scope) {
    if (Array.isArray(value)) { value.forEach(child => visit(child, scope)); return; }
    if (typeof value !== 'object' || value === null || !('type' in value)) return;
    const node = value as SourceNode;
    if ((node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') && !node.declare)
      remember(scope, node.id);
    const functionScope = functionNodes.has(node.type);
    if (functionScope || blockNodes.has(node.type)) scope = { parent: scope, functionScope, bindings: new Map() };
    if (node.type === 'FunctionExpression' || node.type === 'ClassExpression') remember(scope, node.id);
    if (functionScope) for (const param of node.params ?? []) remember(scope, param);
    if (node.type === 'CatchClause') remember(scope, node.param);
    if (node.type === 'VariableDeclaration' && !node.declare) {
      const bindingScope = node.kind === 'var' ? localFunction(scope) : scope;
      for (const { id, init } of node.declarations ?? []) {
        remember(bindingScope, id);
        const host = node.kind === 'const' ? globalFetchHost(init) : undefined;
        if (host && id?.type === 'ObjectPattern' && id.properties?.some(property => {
          const target = property.value as SourceNode | undefined;
          return property.type === 'ObjectProperty' && propertyName(property) === 'fetch' &&
            target?.type === 'Identifier' && target.name === 'fetch';
        })) bindingScope.bindings.set('fetch', { name: host, scope });
      }
    }
    if (node.type === 'ImportDeclaration' && node.importKind !== 'type')
      for (const specifier of node.specifiers ?? []) if (specifier.importKind !== 'type') remember(scope, specifier.local);
    if (node.type === 'CallExpression' || node.type === 'OptionalCallExpression') {
      const callee = sourceValue(node.callee);
      if (callee?.type === 'Identifier' && callee.name === 'fetch') calls.push({ name: 'fetch', scope });
      if (callee?.type === 'MemberExpression' || callee?.type === 'OptionalMemberExpression') {
        const host = globalFetchHost(callee.object);
        if (host && (callee.computed ? callee.property?.type === 'StringLiteral' && callee.property.value === 'fetch'
          : callee.property?.type === 'Identifier' && callee.property.name === 'fetch')) calls.push({ name: host, scope });
      }
    }
    for (const child of Object.values(node)) visit(child, scope);
  }
  const isGlobal = ({ name, scope }: Reference): boolean => {
    for (let current: Scope | null = scope; current; current = current.parent) {
      if (!current.bindings.has(name)) continue;
      const binding = current.bindings.get(name);
      return binding ? isGlobal(binding) : false;
    }
    return true;
  };
  visit(program, { parent: null, functionScope: true, bindings: new Map() });
  return calls.some(isGlobal);
}

function recordedAiUses(fn: FunctionNode, phase: 'trigger' | 'run'): [string, AiUse][] {
  const input = fn.params[0];
  if (input?.type !== 'ObjectPattern') return [];
  const property = input.properties.find(item => item.type === 'ObjectProperty' && !item.computed &&
    item.key.type === 'Identifier' && item.key.name === 'alp');
  if (property?.type !== 'ObjectProperty' || property.value.type !== 'Identifier') return [];
  const sdk = property.value.name, uses: [string, AiUse][] = [];
  let ambiguous = fn.params.slice(1).some(param => bindsName(param as SourceNode, sdk));

  function visit(value: unknown) {
    if (Array.isArray(value)) { value.forEach(item => visit(item)); return; }
    if (typeof value !== 'object' || value === null || !('type' in value)) return;
    const node = value as SourceNode;
    if (changesSdkBinding(node, sdk)) ambiguous = true;
    const method = node.callee, group = method?.object;
    if (node.type === 'CallExpression' && method?.type === 'MemberExpression' && group?.type === 'MemberExpression' &&
        !method.computed && !group.computed && group.object?.type === 'Identifier' && group.object.name === sdk) {
      const operation = group.property?.name + '.' + method.property?.name;
      const input = node.arguments?.[0];
      if ((operation === 'ai.ask' || phase === 'run' && operation === 'tasks.create') && input?.type === 'ObjectExpression' &&
          input.properties?.every(item => item.type === 'ObjectProperty' && !item.computed)) {
        const keys = [...input.properties].reverse();
        const requested = keys.find(item => propertyName(item) === 'request')?.value as SourceNode | undefined;
        const ai = keys.find(item => propertyName(item) === 'ai')?.value as SourceNode | undefined;
        if (ai?.type === 'StringLiteral' && typeof ai.value === 'string' &&
            (operation === 'ai.ask' || requested === undefined || requested.type === 'BooleanLiteral' && requested.value === true))
          uses.push([ai.value, operation]);
      }
    }
    for (const child of Object.values(node)) visit(child);
  }
  visit(fn.body);
  return ambiguous ? [] : uses;
}

/** Validate saved source without importing or executing user code. */
export function analyzeAutomationBundle(files: readonly BundleSource[], validateConfig?: ValidateConfig) {
  const aiUses = new Map<string, Set<AiUse>>();
  const issues: Issue[] = [], modules = new Map<string, Module>(), paths = new Set<string>(), parts = new Set<string>();
  const report = (path: string): Report => (field, line, message) => {
    issues.push({ path: field ? `${path}:${field}` : path, code: 'invalid_value', message, params: { line } });
  };
  if (files.length > maxFiles) report('files')('', 1, `Keep at most ${maxFiles} source files`);
  let bytes = 0;
  for (const file of files.slice(0, maxFiles)) {
    const inFile = report(file.path);
    const encoded = Buffer.from(file.source, 'utf8');
    bytes += encoded.length;
    if (!isAutomationBundlePath(file.path)) {
      inFile('', 1, 'Use a relative source path and a supported extension');
      continue;
    }
    if (paths.has(file.path)) {
      inFile('', 1, 'Use each source file path once');
      continue;
    }
    paths.add(file.path);
    const utf8 = encoded.toString('utf8') === file.source;
    if (encoded.length > fileBytes) inFile('source', 1, 'Keep this file within the per-file bundle limit');
    if (!utf8) inFile('source', 1, 'Save this file as valid UTF-8');
    if (encoded.length > fileBytes || !utf8) continue;
    if (file.path.endsWith('.json')) {
      const source = file.source.replace(/^\uFEFF/, '');
      try { JSON.parse(source); }
      catch (error) {
        const location = error instanceof SyntaxError ? /\bposition (\d+)/.exec(error.message) : null;
        const line = location ? source.slice(0, Number(location[1])).split(/\r\n|[\r\n]/).length : 1;
        inFile('source', line, 'Write valid JSON');
      }
    } else {
      const parsed = parseScript(file, inFile);
      if (parsed) modules.set(file.path, parsed);
    }
  }
  if (bytes > totalBytes) report('files')('', 1, 'Keep the bundle within the total byte limit');
  for (const module of modules.values()) validateImports(module, paths, parts);

  const main = modules.get(entry), lines = new Map<string, number>();
  let config: unknown, run: BundleDoc | null = null, trigger: BundleDoc | null = null;
  let configPath: string = entry, configStart = 1, configRead = false;
  if (!paths.has(entry)) report(entry)('', 1, 'Add main.ts as the bundle entry');
  if (main) {
    const names = new Map([...modules].map(([path, module]) => [path, moduleNames(module)]));
    const moduleNamesAtMain = names.get(entry)!;
    for (const item of moduleNamesAtMain.starExports)
      main.report('exports', lineOf(item.anchor), 'Export config, trigger and run by name');
    for (const item of moduleNamesAtMain.exports) {
      if (item.name !== 'config' && item.name !== 'run' && item.name !== 'trigger')
        main.report('exports', lineOf(item.anchor), 'Export only config, trigger and run from main.ts');
    }
    for (const name of ['config', 'trigger', 'run'] as const) {
      const item = moduleNamesAtMain.exports.find(candidate => candidate.name === name);
      if (!item) {
        if (name !== 'trigger') main.report(name, 1, `Export ${name} from main.ts`);
        continue;
      }
      const source = findBinding(modules, names, main, item);
      if (name === 'config') {
        if (source?.binding.kind === 'value' && source.binding.constant && source.binding.expression) {
          configPath = source.module.path;
          configStart = lineOf(source.binding.expression);
          const previousIssues = issues.length;
          config = readConfig(source.binding.expression, [], source.module.report, lines);
          configRead = issues.length === previousIssues;
        } else main.report(name, lineOf(item.anchor), 'Export config as a const initialized with a literal value');
        continue;
      }
      const binding = source?.binding;
      const expression = binding?.kind === 'value' ? binding.expression : null;
      if (!source || !binding || (binding.kind !== 'function' && expression?.type !== 'ArrowFunctionExpression' &&
        !(expression?.type === 'FunctionExpression' && !expression.generator))) {
        main.report(name, lineOf(item.anchor), `Export ${name} as an ordinary function`);
        continue;
      }
      const fn = binding.kind === 'function' ? binding.node : expression as FunctionNode;
      for (const [ai, use] of recordedAiUses(fn, name)) {
        const known = aiUses.get(ai) ?? new Set<AiUse>();
        known.add(use);
        aiUses.set(ai, known);
      }
      const doc = readDoc(source.module, binding.anchor, name);
      if (name === 'run') run = doc;
      else trigger = doc;
    }
  }
  const configLine: ConfigLine = path => {
    for (let length = path.length; length >= 0; length--) {
      const line = lines.get(pathKey(path.slice(0, length)));
      if (line !== undefined) return line;
    }
    return configStart;
  };
  if (configRead && validateConfig) issues.push(...validateConfig(config, configPath, configLine));
  if (issues.length || !run)
    throw new Problem(PROBLEM_CODE.invalidInput, 'Fix the issues in the automation bundle', undefined,
      { reason: { kind: 'validation_error' }, issues });
  const directFetch = [...modules.values()].some(module => callsGlobalFetch(module.script.program));
  return { config, configPath, configLine, docs: { run, trigger }, parts: [...parts].sort(), directFetch,
    aiUses: Object.fromEntries([...aiUses].map(([name, uses]) => [name, [...uses].sort()])) };
}
