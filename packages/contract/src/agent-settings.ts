/** Target configuration contract. Stage 1 prepares it; stage 3 replaces the old server-settings DSL. */
import { z } from 'zod';
import { selectedValueSchema } from '@alpacawork/raw/values';
import { AGENT_ADAPTERS, LAUNCH_MODES, builtinAdapterIdSchema, optionsBase, unavailableAgentKind, type BuiltinAdapterId, type LaunchMode } from './agent-adapters.js';
import { isParamName } from './agent-variables.js';
import { InvalidLaunchOptions, optionReferences, parseLaunchOptions, type LaunchOptions } from './launch-options.js';
import { agentEnvironmentNamesSchema } from './agent-environment.js';

const issue = (ctx: z.RefinementCtx, path: (string | number)[], message: string) =>
  ctx.addIssue({ code: 'custom', path, message });
const paramNameSchema = z.string().refine(isParamName, 'Reserved or invalid param name');
const candidateSchema = z.string().refine(value => value.trim().length > 0 && value === value.trim() && !value.includes(','),
  'Candidates must be nonblank, trimmed and contain no comma');
export const paramValuesSchema = z.array(candidateSchema).superRefine((values, ctx) => {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (seen.has(value)) issue(ctx, [index], 'Duplicate candidate');
    if (value === '-' && index !== 0) issue(ctx, [index], 'Only the first candidate may be -');
    seen.add(value);
  });
});
export const paramsSchema = z.record(paramNameSchema, paramValuesSchema);
export const selectionSchema = z.record(paramNameSchema, selectedValueSchema);
export type Selection = z.infer<typeof selectionSchema>;
/** Empty whole input is []; an empty component or duplicate is an error at its index. */
export function parseParamValues(input: string): string[] {
  return paramValuesSchema.parse(input.trim() === '' ? [] : input.split(',').map(value => value.trim()));
}
export const agentSettingShapeSchema = z.object({
  adapter: builtinAdapterIdSchema.optional(), enabled: z.boolean().optional(), params: paramsSchema.optional(),
  without: z.record(z.string(), z.array(paramNameSchema)).optional(),
  env: agentEnvironmentNamesSchema.optional(),
  command: z.string().regex(/^\/(?!.*[\r\n\0])(?!.*\s+-).*\S$/, 'Command must be an absolute executable path without arguments').optional(),
  options: z.object({ base: z.string().regex(/^[a-f0-9]{64}$(?![\s\S])/), start: z.string(), resume: z.string() }).strict().optional(),
}).strict();
export type WrittenAgentSetting = z.infer<typeof agentSettingShapeSchema>;
export type AgentSetting = WrittenAgentSetting & { params: z.infer<typeof paramsSchema> };
export type ResolvedAgentSetting = AgentSetting & Required<Pick<AgentSetting, 'env' | 'without' | 'options'>>;
export function settingAdapter(profile: string, setting: Pick<WrittenAgentSetting, 'adapter'>): BuiltinAdapterId | null {
  return setting.adapter ?? (Object.hasOwn(AGENT_ADAPTERS, profile) ? profile as BuiltinAdapterId : null);
}

function readOptions(options: Record<LaunchMode, string>) {
  const all = new Set<string>(), required = new Set<string>();
  const modes = LAUNCH_MODES.map(mode => {
    try {
      const ast = parseLaunchOptions(options[mode]);
      const refs = optionReferences(ast);
      for (const key of refs.all) all.add(key);
      for (const key of refs.required) required.add(key);
      return { mode, system: refs.system, all: refs.all };
    } catch (error) {
      if (!(error instanceof InvalidLaunchOptions)) throw error;
      return { mode, error };
    }
  });
  return { modes, all, required };
}
function canOmitParam(params: AgentSetting['params'], refs: ReturnType<typeof readOptions>, key: string): boolean {
  return key !== 'model' && Object.hasOwn(params, key) && refs.all.has(key) && !refs.required.has(key);
}

/** Resolve defaults for a shape-checked setting. Contextual errors remain available to the editor. */
export function resolveAgentSetting(id: BuiltinAdapterId, input: WrittenAgentSetting): ResolvedAgentSetting {
  const adapter = AGENT_ADAPTERS[id];
  const params = Object.fromEntries(Object.entries({ ...adapter.defaultParams, ...input.params })
    .map(([key, values]) => [key, [...values]]));
  const options = input.options ? { ...input.options } : { base: optionsBase(id), ...adapter.options };
  const without = Object.fromEntries(Object.entries(input.without ?? {}).map(([model, keys]) => [model, [...keys]]));
  return { ...input, params, options, without, env: [...(input.env ?? adapter.defaultEnv)] };
}
export const defaultAgentSetting = (id: BuiltinAdapterId): ResolvedAgentSetting => resolveAgentSetting(id, {});

export function sameSettingValues(left: readonly string[] | undefined, right: readonly string[] | undefined): boolean {
  return left !== undefined && right !== undefined && left.length === right.length && left.every((value, index) => value === right[index]);
}

/** Write only overrides. Callers of the text-based config API can still pin a default explicitly. */
export function agentSettingOverrides(id: BuiltinAdapterId, setting: ResolvedAgentSetting): WrittenAgentSetting {
  const adapter = AGENT_ADAPTERS[id];
  const { params, env, without, options, enabled, ...identity } = setting;
  const overrides = Object.fromEntries(Object.entries(params).filter(([key, values]) =>
    !Object.hasOwn(adapter.defaultParams, key) || !sameSettingValues(values, adapter.defaultParams[key])));
  return { ...identity, ...(enabled === false ? { enabled } : {}),
    ...(Object.keys(overrides).length ? { params: overrides } : {}),
    ...(!sameSettingValues(env, adapter.defaultEnv) ? { env } : {}),
    ...(Object.keys(without).length ? { without } : {}),
    ...(options.start !== adapter.options.start || options.resume !== adapter.options.resume ? { options } : {}) };
}

function validateSetting(id: BuiltinAdapterId, setting: ResolvedAgentSetting,
  add: (path: (string | number)[], message: string) => void): void {
  const adapter = AGENT_ADAPTERS[id];
  const refs = readOptions(setting.options);
  if (setting.command !== undefined && adapter.command === null) add(['command'], 'This adapter uses a bundled runtime and does not accept command');
  for (const { mode, system, all, error } of refs.modes) {
    if (/(?:^|[\s'"\[])--command(?:[\s='"\]]|$)/.test(setting.options[mode])) add(['options', mode], 'command is configured separately from launch options');
    if (error) { add(['options', mode], error.message); continue; }
    for (const name of system) if (!adapter.system[mode].includes(name))
      add(['options', mode], `System variable {${name}} is not supplied by ${id} in ${mode} mode`);
    for (const name of all) if (!Object.hasOwn(setting.params, name))
      add(['options', mode], `Unknown or reserved variable: ${name}`);
  }
  for (const name of refs.required) {
    const values = setting.params[name];
    if (values && (values.length === 0 || values[0] === '-'))
      add(['params', name], 'Required reference needs a nonempty default and cannot start with -');
  }
  for (const [model, keys] of Object.entries(setting.without)) {
    if (model === '-' || !setting.params.model?.includes(model)) {
      add(['without', model], 'Unknown model candidate');
      add(['params', 'model'], `without.${model} refers to a missing model candidate`);
    }
    const seen = new Set<string>();
    keys.forEach((key, index) => {
      if (seen.has(key)) add(['without', model, index], 'Duplicate without param');
      if (!canOmitParam(setting.params, refs, key)) {
        add(['without', model, index], 'without must reference an existing optional param');
        add(['params', key], `without.${model} references this param, which must exist and be optional`);
      }
      seen.add(key);
    });
  }
  setting.env.forEach((name, index) => {
    if (adapter.fixedEnv.includes(name)) add(['env', index], 'Environment name is owned by the adapter');
  });
}
/** Same contextual schema for form, YAML/config-set and admission; no old DSL recovery. */
export const agentSettingSchemaFor = (profile: string) => agentSettingShapeSchema.transform((input, ctx) => {
  const id = settingAdapter(profile, input);
  if (!id || (Object.hasOwn(AGENT_ADAPTERS, profile) && id !== profile)) {
    issue(ctx, ['adapter'], id ? 'A built-in profile name must use its own adapter' : unavailableAgentKind(profile));
    return z.NEVER;
  }
  const setting = resolveAgentSetting(id, input);
  validateSetting(id, setting, (path, message) => issue(ctx, path, message));
  return setting;
});
export const agentSettingsSchema = z.record(z.string().regex(/^[a-z][a-z0-9_-]*$(?![\s\S])/), z.unknown())
  .transform((settings, ctx): Record<string, ResolvedAgentSetting> => Object.fromEntries(Object.entries(settings).flatMap(([profile, input]) => {
    const parsed = agentSettingSchemaFor(profile).safeParse(input);
    if (parsed.success) return [[profile, parsed.data]];
    for (const problem of parsed.error.issues) ctx.addIssue({ ...problem, path: [profile, ...problem.path] });
    return [];
  })));
/** Configuration order defines the default; disabled profiles remain in the saved settings. */
export function enabledAgents<T extends { enabled?: boolean }>(settings: Record<string, T>): [string, T][] {
  return Object.entries(settings).filter(([, setting]) => setting.enabled !== false);
}
export type CompiledAgentSetting = {
  adapter: BuiltinAdapterId; setting: ResolvedAgentSetting; options: Record<LaunchMode, LaunchOptions>;
  references: { all: Set<string>; required: Set<string> };
};
/** Detached validated copy; changing a caller's draft cannot mutate a compiled setting. */
export function compileAgentSetting(profile: string, input: unknown): CompiledAgentSetting {
  const setting = agentSettingSchemaFor(profile).parse(input);
  const adapter = settingAdapter(profile, setting)!;
  const source = setting.options;
  const options = { start: parseLaunchOptions(source.start), resume: parseLaunchOptions(source.resume) };
  const references = { all: new Set<string>(), required: new Set<string>() };
  for (const ast of Object.values(options)) {
    const refs = optionReferences(ast);
    refs.all.forEach(name => references.all.add(name)); refs.required.forEach(name => references.required.add(name));
  }
  return { adapter, setting, options, references };
}
