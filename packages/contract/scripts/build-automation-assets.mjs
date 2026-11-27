import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { posix } from 'node:path';
import { z } from 'zod';
import {
  AUTOMATION_DECLARATION_PATHS, automationConfigSchema, automationEvents, automationJson, automationOperationErrorCodes,
  automationOperations, automationRunResultSchema, automationTriggerResultSchema,
} from '../dist/automation-program.js';

// Put Zod's public declaration graph in private ambient modules. Type-only imports from the
// generated SDK then resolve in an empty project without borrowing the author's node_modules.
function bundledZod() {
  const root = new URL('./', import.meta.resolve('zod/v4'));
  const notice = readFileSync(new URL('../LICENSE', root), 'utf8');
  const modules = new Map();
  const pending = ['classic/index'];
  for (const path of pending) {
    const name = 'alpacawork-zod/' + path;
    if (modules.has(name)) continue;
    const source = readFileSync(new URL(path + '.d.ts', root), 'utf8')
      .replace(/^(export )?declare /gm, (_, exported) => exported ?? '')
      .replace(/(['"])(\.{1,2}\/[^'"]+\.js)\1/g, (_, quote, specifier) => {
        const child = posix.normalize(posix.join(posix.dirname(path), specifier)).slice(0, -3);
        if (child.startsWith('../')) throw new Error('Zod declaration outside v4: ' + specifier);
        pending.push(child);
        return quote + 'alpacawork-zod/' + child + quote;
      });
    modules.set(name, 'declare module ' + JSON.stringify(name) + ' {\n' + source + '\n}');
  }
  return '/* Bundled Zod declarations\n' + notice.replaceAll('*/', '* /') + '\n*/\n' + [...modules.values()].join('\n\n');
}

// The contract uses the structural JSON Schema vocabulary below. Constraints such as byte sizes
// and cross-field refinements are preserved by runtime Zod validation rather than exported as types.
function schemaTypes(name, contract, io = 'output') {
  const schema = z.toJSONSchema(contract, {
    io,
    unrepresentable: 'any',
    override: ({ zodSchema, jsonSchema }) => {
      if (zodSchema instanceof z.ZodUndefined) jsonSchema.not = {};
    },
  });
  const definitions = Object.entries(schema.$defs ?? {});
  const aliases = new Map(definitions.map(([key], index) => ['#/$defs/' + key, name + '__' + index]));
  aliases.set('#', name);
  function type(node) {
    if (node === false || (node.not && Object.keys(node.not).length === 0)) return 'never';
    if (node === true) return 'unknown';
    if (node.$ref) {
      const alias = aliases.get(node.$ref);
      if (!alias) throw new Error('Unknown schema reference for ' + name + ': ' + node.$ref);
      return alias;
    }
    if ('const' in node) return JSON.stringify(node.const);
    if (node.enum) return node.enum.map(value => JSON.stringify(value)).join(' | ') || 'never';
    const alternatives = node.oneOf ?? node.anyOf;
    if (alternatives) return alternatives.map(type).join(' | ') || 'never';
    if (node.allOf) return node.allOf.map(part => '(' + type(part) + ')').join(' & ');
    if (Array.isArray(node.type)) return node.type.map(tag => type({ ...node, type: tag })).join(' | ');
    switch (node.type) {
      case 'integer': return 'number';
      case 'null':
      case 'number':
      case 'boolean':
      case 'string': return node.type;
      case 'array': {
        const prefix = io === 'input' ? 'readonly ' : '';
        if (node.prefixItems) return prefix + '[' + node.prefixItems.map(type).join(', ') + ']';
        return prefix + '(' + type(node.items ?? true) + ')[]';
      }
      case 'object': {
        const fields = Object.entries(node.properties ?? {}).map(([key, property]) =>
          JSON.stringify(key) + (node.required?.includes(key) ? ': ' : '?: ') + type(property));
        if (node.additionalProperties && typeof node.additionalProperties === 'object')
          fields.push('[key: string]: ' + type(node.additionalProperties));
        if (!fields.length) return node.additionalProperties === false ? 'Record<string, never>' : 'Record<string, unknown>';
        return '{ ' + fields.join('; ') + ' }';
      }
      case undefined: return 'unknown';
      default: throw new Error('Unsupported schema type for ' + name + ': ' + String(node.type));
    }
  }
  return [
    'export type ' + name + ' = ' + type(schema) + ';',
    ...definitions.map(([key, value]) => 'type ' + aliases.get('#/$defs/' + key) + ' = ' + type(value) + ';'),
  ].join('\n');
}

const typeName = name => name.split(/[._-]/).map(word => word[0].toUpperCase() + word.slice(1)).join('');

function methods(phase) {
  const members = new Map([['z', '/** Build a Zod schema for a structured AI answer. */\nreadonly z: typeof z;']]);
  const groups = new Map();
  for (const [name, operation] of Object.entries(automationOperations)) {
    if (operation.phase !== 'both' && operation.phase !== phase) continue;
    const split = name.split('.');
    const method = split.at(-1);
    const input = typeName(name) + 'Input';
    const output = typeName(name) + 'Output';
    const doc = '/** ' + operation.description + ' */\n';
    let signature;
    if (name === 'ai.ask') {
      const base = 'Named<Omit<' + input + ', "schema">, C>';
      signature =
        method + '(input: ' + base + ' & { schema?: undefined }): Promise<string>;\n' +
        doc + method + '<S extends z.ZodType>(input: ' + base + ' & { schema: S }): Promise<z.output<S>>;';
    } else {
      const optional = name === 'disable' || name === 'tasks.list';
      signature = method + '(input' + (optional ? '?' : '') + ': Named<' + input + ', C>): Promise<' + output + '>;';
    }
    if (split.length === 1) members.set(name, doc + signature);
    else {
      const group = groups.get(split[0]) ?? [];
      group.push(doc + signature);
      groups.set(split[0], group);
    }
  }
  for (const [name, group] of groups) members.set(name, 'readonly ' + name + ': {\n' + group.join('\n') + '\n};');
  return [...members.values()].join('\n');
}

function sdkDeclaration() {
  const events = Object.entries(automationEvents);
  const operations = Object.entries(automationOperations);
  return [
    'declare module "alpacawork" {',
    'import { z } from "alpacawork-zod/classic/index";',
    schemaTypes('Json', automationJson),
    schemaTypes('ConfigShape', automationConfigSchema, 'input'),
    // Give satisfies a literal-preserving string context without changing what strings are valid.
    'type DeclaredName = "" | (string & Record<never, never>);',
    'type ConfigUses = NonNullable<ConfigShape["uses"]>;',
    'export type Config = Omit<ConfigShape, "uses"> & { uses?: Omit<ConfigUses, "send"> & { send?: readonly DeclaredName[] } };',
    ...events.map(([name, row]) => schemaTypes(typeName(name) + 'Event', row.event)),
    'export type AutomationEvent = ' + events.map(([name]) => typeName(name) + 'Event').join(' | ') + ';',
    schemaTypes('TriggerResult', automationTriggerResultSchema, 'input'),
    schemaTypes('RunResult', automationRunResultSchema, 'input'),
    ...operations.flatMap(([name, operation]) => [
      schemaTypes(typeName(name) + 'Input', operation.input, 'input'),
      schemaTypes(typeName(name) + 'Output', operation.output),
    ]),
    'export type AutomationOperation = ' + operations.map(([name]) => JSON.stringify(name)).join(' | ') + ';',
    'export type AutomationErrorCode = ' + automationOperationErrorCodes.map(code => JSON.stringify(code)).join(' | ') + ';',
    'export interface AlpacaworkError extends Error { readonly code: AutomationErrorCode; readonly operation: AutomationOperation; }',
    'type AiName<C extends Config> = Config extends C ? string : C extends { uses: { ai: infer A } } ? Extract<keyof A, string> : never;',
    'type DestinationName<C extends Config> = Config extends C ? string : C extends { uses: { send: readonly (infer N)[] } } ? N : never;',
    'type Named<T, C extends Config> = { [K in keyof T]: K extends "ai" ? AiName<C> : K extends "to" ? DestinationName<C> : T[K] };',
    'type EventFor<C extends Config> = Extract<AutomationEvent, { kind: C["on"]["event"] }>;',
    'export interface TriggerSdk<C extends Config = Config> {',
    methods('trigger'), '}',
    'export interface RunSdk<C extends Config = Config> {',
    methods('run'), '}',
    'export interface TriggerInput<C extends Config = Config> { event: EventFor<C>; alp: TriggerSdk<C>; signal: AbortSignal; preview: boolean; }',
    'export interface RunInput<C extends Config = Config> { event: EventFor<C>; context: Json; alp: RunSdk<C>; signal: AbortSignal; preview: boolean; }',
    '}',
  ].join('\n\n') + '\n';
}

const root = new URL('../automation-examples/', import.meta.url);
const examples = readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(({ name }) => {
  const folder = new URL(name + '/', root);
  return { name, files: readdirSync(folder).sort().map(path => ({ path, source: readFileSync(new URL(path, folder), 'utf8') })) };
});
const [sdkPath, zodPath] = AUTOMATION_DECLARATION_PATHS;
const declarations = [
  { path: sdkPath, source: '/// <reference path="./' + zodPath + '" />\n' +
    '// Generated from the alpacawork automation contract.\n' + sdkDeclaration() },
  { path: zodPath, source: bundledZod() + '\n' },
];
writeFileSync(new URL('../dist/automation-program-assets.js', import.meta.url),
  'export const automationDeclarations = ' + JSON.stringify(declarations) + ';\n' +
  'export const automationExamples = ' + JSON.stringify(examples) + ';\n');
writeFileSync(new URL('../dist/automation-program-assets.d.ts', import.meta.url),
  'export declare const automationDeclarations: import("./automation-program.js").AutomationDeclarations;\n' +
  'export declare const automationExamples: readonly {name: string; files: readonly {path: string; source: string}[]}[];\n');
