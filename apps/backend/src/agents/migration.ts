/** One-shot, pure old-format conversion. No filesystem, database, process or provider access.
 * Ordinary readers must never import this module. Maintenance owns backup, quiescence and publication.
 */
import { isDeepStrictEqual as equal } from 'node:util';
import { z } from 'zod';
import { AGENT_ADAPTERS, builtinAdapterIdSchema, optionsBase, type BuiltinAdapterId } from '@alpacawork/contract/agent-adapters';
import { agentSettingsSchema, agentSettingSchemaFor, compileAgentSetting, selectionSchema, type AgentSetting, type Selection } from '@alpacawork/contract/agent-settings';
import { resolveAgentSelection, SelectionRequired, type SelectionProblem } from '@alpacawork/contract/agent-selection';
import { runtimeRunRecordSchema } from '@alpacawork/contract/run';
import { launchSchema } from '@alpacawork/contract/run-protocol';
import { agentLaunchSchema, type AgentLaunch } from '@alpacawork/contract/agent-launch';
import { LEGACY_GENERATIONS, LEGACY_ACTIVITIES, LEGACY_FORWARDED_ENV, LEGACY_PROTOCOLS, MIGRATION_DEFAULTS, type LegacyArgv } from './migration-defaults.js';

export type MigrationDiagnostic = { path: string; code: string; reason: string };
export type MigrationNotice = { path: string; code: string; source?: string; reason: string; problems?: SelectionProblem[] };
export type MigrationResult<T> = { ok: true; value: T; notices: MigrationNotice[] }
  | { ok: false; diagnostics: MigrationDiagnostic[] };
class Rejected extends Error {
  constructor(readonly diagnostic: MigrationDiagnostic) { super(diagnostic.reason); }
}
function reject(path: string, code: string, reason: string): never { throw new Rejected({ path, code, reason }); }
const at = (path: string, key: string | number) => `${path}[${JSON.stringify(key)}]`;
type ObjectValue = Record<string, unknown>;
function differencePath(expected: unknown, actual: unknown, path: string): string {
  if (equal(expected, actual)) return path;
  if (expected !== null && actual !== null && typeof expected === 'object' && typeof actual === 'object') {
    const left = expected as ObjectValue, right = actual as ObjectValue;
    for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
      if (!Object.hasOwn(left, key) || !Object.hasOwn(right, key)) return at(path, key);
      if (!equal(left[key], right[key])) return differencePath(left[key], right[key], at(path, key));
    }
  }
  return path;
}
function object(value: unknown, path: string): ObjectValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) reject(path, 'invalid_shape', 'Expected an object');
  return value as ObjectValue;
}
function checked<T>(schema: z.ZodType<T>, value: unknown, path: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0]!;
    reject(issue.path.reduce<string>((p, k) => at(p, String(k)), path), 'invalid_shape', issue.message);
  }
  return result.data;
}
function attempt<T>(fn: (notices: MigrationNotice[]) => T): MigrationResult<T> {
  const notices: MigrationNotice[] = [];
  try { return { ok: true, value: fn(notices), notices }; }
  catch (error) {
    if (!(error instanceof Rejected)) throw error;
    return { ok: false, diagnostics: [error.diagnostic] };
  }
}

// Kept here: normal reads have no old DSL parser to import.
type Field = { choices: string[]; default: string; fields?: Record<string, Record<string, Field>> };
const fieldSchema: z.ZodType<Field> = z.lazy(() => z.object({
  choices: z.array(z.string().min(1)).min(1), default: z.string().min(1),
  fields: z.record(z.string(), z.record(z.string(), fieldSchema)).optional(),
}).strict());
const argvSchema = z.array(z.union([z.string(), z.array(z.string()).min(1)])).min(1);
const controlKeys = new Set(['start', 'resume', 'input', 'read']);
function fieldsOf(raw: ObjectValue, path: string): Record<string, Field> {
  return Object.fromEntries(Object.entries(raw).filter(([key]) => !controlKeys.has(key))
    .map(([key, value]) => [key, checked(fieldSchema, value, at(path, key))]));
}
function candidates(field: Field, path: string): string[] {
  if (new Set(field.choices).size !== field.choices.length || !field.choices.includes(field.default))
    reject(path, 'invalid_choices', 'Choices must be unique and contain their default');
  if (field.choices.includes('-')) reject(path, 'literal_sentinel', 'Old literal - cannot become the new unspecified sentinel');
  return [field.default, ...field.choices.filter(value => value !== field.default)];
}
function flattenFields(fields: Record<string, Field>, path: string): Pick<AgentSetting, 'params' | 'without'> {
  const params: Record<string, string[]> = Object.create(null);
  const without: Record<string, string[]> = Object.create(null);
  for (const [key, field] of Object.entries(fields)) params[key] = candidates(field, at(path, key));
  for (const [key, field] of Object.entries(fields)) {
    if (!field.fields) continue;
    if (key !== 'model') reject(at(at(path, key), 'fields'), 'complex_fields', 'Only one level of model-dependent fields can become without');
    for (const [model, branch] of Object.entries(field.fields)) {
      if (!field.choices.includes(model)) reject(at(at(at(path, key), 'fields'), model), 'complex_fields', 'Branch is not a model candidate');
      for (const [child, value] of Object.entries(branch)) {
        const childPath = at(at(at(at(path, key), 'fields'), model), child);
        if (value.fields || Object.hasOwn(fields, child)) reject(childPath, 'complex_fields', 'Nested or coexisting field owners cannot become without');
        const values = candidates(value, childPath);
        if (params[child] && !equal(params[child], values)) reject(childPath, 'complex_fields', 'Model branches have different choices/defaults');
        params[child] = values;
      }
    }
    const children = new Set(Object.values(field.fields).flatMap(branch => Object.keys(branch)));
    for (const model of field.choices) {
      const absent = [...children].filter(child => !Object.hasOwn(field.fields![model] ?? {}, child));
      if (absent.length) without[model] = absent;
    }
  }
  return { params, ...(Object.keys(without).length ? { without } : {}) };
}
function verifyArgvFields(argv: LegacyArgv, fields: Record<string, Field>, path: string): void {
  const all = new Set(Object.keys(fields));
  for (const field of Object.values(fields)) for (const branch of Object.values(field.fields ?? {}))
    Object.keys(branch).forEach(key => all.add(key));
  for (const [i, item] of argv.entries()) {
    const conditional = Array.isArray(item);
    let hasConditionalField = false;
    for (const word of conditional ? item : [item]) for (const match of word.matchAll(/\{([a-z][a-z0-9_]*)\}/g)) {
      const key = match[1]!;
      const system = ['session', 'result', 'prompt'].includes(key);
      if (!system && !all.has(key)) reject(at(path, i), 'unknown_reference', 'Old argv reference has no declared field or known system value');
      if (system && conditional) reject(at(path, i), 'conditional_system', 'Old system values cannot be conditional');
      if (all.has(key) && !Object.hasOwn(fields, key)) {
        hasConditionalField = true;
        if (!conditional) reject(at(path, i), 'complex_fields', 'Model-dependent field needs an old argv group');
      }
    }
    if (conditional && !hasConditionalField) reject(at(path, i), 'invalid_group', 'Old argv group must depend on a model-dependent field');
  }
}
type LegacyId = keyof typeof LEGACY_PROTOCOLS;
const legacyIds = Object.keys(LEGACY_PROTOCOLS) as LegacyId[];
function argvAdapter(argv: LegacyArgv, path: string): LegacyId {
  // Exact command identity and verified declaration, never basename/profile/provider inference.
  const id = legacyIds.find(id => AGENT_ADAPTERS[id].prefix.every((word, i) => argv[i] === word))
    ?? LEGACY_GENERATIONS.find(g => g.prefix.every((word, i) => argv[i] === word))?.adapter;
  if (!id) reject(path, 'unknown_prefix', 'No verified direct prefix; wrappers and unknown CLI kinds require a decision');
  return id;
}
function verifyProtocol(id: LegacyId, argv: LegacyArgv, input: unknown, read: unknown, path: string, notices: MigrationNotice[]): void {
  const variants: { input: unknown; read: unknown; source: string }[] = [
    ...(AGENT_ADAPTERS[id].prefix.every((word, i) => argv[i] === word) ? [{ ...LEGACY_PROTOCOLS[id], source: 'template' }] : []),
    ...LEGACY_GENERATIONS.filter(g => g.adapter === id && g.prefix.every((word, i) => argv[i] === word)).map(g => ({ input: 'input' in g ? g.input : null, read: g.read, source: g.commit })),
  ];
  const actual = object(read, at(path, 'read'));
  const { activity, ...rest } = actual;
  const matched = variants.find(v => {
    const { activity: _ignored, ...oldRead } = v.read as ObjectValue;
    return equal(input ?? null, v.input) && equal(rest, oldRead);
  });
  if (!matched) {
    const inputMatch = variants.find(v => equal(input ?? null, v.input));
    if (!inputMatch) reject(at(path, 'input'), 'unknown_input', 'Input/receipt semantics do not match a verified historical shape');
    const { activity: _ignored, ...expected } = inputMatch.read as ObjectValue;
    if (!equal(rest, expected)) reject(differencePath(expected, rest, at(path, 'read')), 'unknown_read', 'Output/session/usage semantics do not match a verified historical shape');
    reject(at(path, 'read'), 'unknown_read', 'Output/session/usage semantics do not match a verified historical shape');
  }
  if (activity !== undefined) {
    const known = LEGACY_ACTIVITIES.find(v => Object.hasOwn(v.declarations, id) &&
      equal(activity, v.declarations[id as keyof typeof v.declarations]));
    if (!known) reject(at(at(path, 'read'), 'activity'), 'unknown_read', 'Activity is not a verified historical declaration');
    notices.push({ path: at(at(path, 'read'), 'activity'), code: 'unused_activity_removed', source: known.source,
      reason: 'Exact historical unused declaration is archived by maintenance; runtime code owns activity' });
  }
}
/** Preserve the historical global extra names. Conversation homes are supplied by the adapter. */
function migratedEnv(id: BuiltinAdapterId): string[] {
  const fixed = new Set(Object.values(AGENT_ADAPTERS).flatMap(adapter => [...adapter.fixedEnv]));
  return [...AGENT_ADAPTERS[id].fixedEnv, ...LEGACY_FORWARDED_ENV.filter(name => !fixed.has(name))];
}
function migrateValues(id: BuiltinAdapterId, input: unknown, path: string, notices: MigrationNotice[], preserveSpeed = false): Selection {
  const values = checked(z.record(z.string(), z.string().min(1)), input, path);
  const result: Selection = { ...values };
  if (id === 'codex' && Object.hasOwn(values, 'speed') && !preserveSpeed) {
    if (Object.hasOwn(values, 'fast')) reject(at(path, 'speed'), 'ambiguous_speed', 'Both old speed and fast are present');
    if (values.speed !== 'default' && values.speed !== 'fast') reject(at(path, 'speed'), 'unknown_speed', 'Only verified speed=default/fast can migrate');
    result.fast = values.speed === 'default' ? null : 'fast'; delete result.speed;
    notices.push({ path: at(path, 'speed'), code: 'speed_to_fast', reason: 'Continuation selection becomes fast:null/fast; historical argv keeps the actual old tier' });
  }
  return checked(selectionSchema, result, path);
}

/** Quotes are only word boundaries in the current grammar. Braces are still references inside quotes. */
function optionWord(word: string, path: string): string {
  const withoutReferences = word.replace(/\{[a-z][a-z0-9_]*\}/g, '');
  if (/[{}]/.test(withoutReferences)) reject(path, 'literal_braces_unresolved', 'Current parser cannot preserve literal braces/JSON; raw input must remain in the maintenance backup');
  // Adjacent fragments encode both quote characters without inventing backslash escaping.
  return word.split("'").map(fragment => `'${fragment}'`).join(`"'"`);
}
function optionsOf(argv: LegacyArgv, id: LegacyId, path: string): string {
  return argv.slice(AGENT_ADAPTERS[id].prefix.length).map((item, i) => {
    const itemPath = at(path, i + AGENT_ADAPTERS[id].prefix.length);
    return Array.isArray(item) ? `[${item.map((word, j) => optionWord(word, at(itemPath, j))).join(' ')}]` : optionWord(item, itemPath);
  }).join(' ');
}
function convertedFields(fields: Record<string, Field>, id: LegacyId, path: string, known: boolean) {
  const target = flattenFields(fields, path);
  if (id === 'codex') {
    if (fields.speed) {
      const speed = fields.speed;
      if (known && (speed.fields || speed.default !== 'default' || !equal(candidates(speed, at(path, 'speed')), ['default', 'fast']) || fields.fast))
        reject(at(path, 'speed'), 'unknown_speed', 'Expected the verified default/fast field with default=default');
      if (known) delete target.params.speed;
    }
    target.params.fast ??= known ? ['-', 'fast'] : [];
  }
  for (const key of Object.keys(AGENT_ADAPTERS[id].defaultParams)) target.params[key] ??= [];
  return target;
}
function setting(profile: string, input: unknown, path: string, notices: MigrationNotice[]): AgentSetting {
  const raw = object(input, path);
  const start = checked(argvSchema, raw.start, at(path, 'start'));
  const resume = checked(argvSchema, raw.resume, at(path, 'resume'));
  const id = argvAdapter(start, at(path, 'start'));
  if (argvAdapter(resume, at(path, 'resume')) !== id) reject(at(path, 'resume'), 'different_kind', 'Start and resume have different CLI kinds');
  verifyProtocol(id, start, raw.input, raw.read, path, notices);
  verifyProtocol(id, resume, raw.input, raw.read, at(path, 'resume'), []);
  const fields = fieldsOf(raw, path);
  verifyArgvFields(start, fields, at(path, 'start'));
  verifyArgvFields(resume, fields, at(path, 'resume'));
  const known = MIGRATION_DEFAULTS.find(item => item.adapter === id && equal(start, item.start) && equal(resume, item.resume))
    ?? LEGACY_GENERATIONS.find(item => item.adapter === id && equal(start, item.start) && equal(resume, item.resume));
  const target = convertedFields(fields, id, path, !!known);
  const env = migratedEnv(id).filter(name => !AGENT_ADAPTERS[id].fixedEnv.includes(name));
  const result: AgentSetting = { ...target, ...(profile === id ? {} : { adapter: id }), env };
  if (known) notices.push({ path, code: 'historical_default', source: 'id' in known ? known.id : known.commit, reason: 'Verified historical shape uses target defaults without options or edited marker' });
  else {
    result.options = { base: optionsBase(id), start: optionsOf(start, id, at(path, 'start')), resume: optionsOf(resume, id, at(path, 'resume')) };
    if ([...start, ...resume].flat().some(word => word.includes('{prompt}')) ||
        !AGENT_ADAPTERS[id].prefix.every((word, i) => start[i] === word && resume[i] === word))
      reject(at(path, 'start'), 'historical_execution_only', 'Edited native/retired bridge argv is history only; it cannot be issued to the new manager');
    notices.push({ path, code: 'edited_options', reason: 'Non-default argv retained in original order; options.base identifies the target default, not an unknown edit ancestor' });
  }
  checked(agentSettingSchemaFor(profile), result, path);
  return result;
}
export function migrateAgentSettings(input: unknown): MigrationResult<Record<string, AgentSetting>> {
  return attempt(notices => settings(input, notices));
}
function settings(input: unknown, notices: MigrationNotice[]): Record<string, AgentSetting> {
  const target = Object.fromEntries(Object.entries(object(input, '$.agents')).map(([profile, value]) =>
    [profile, setting(profile, value, at('$.agents', profile), notices)]));
  checked(agentSettingsSchema, target, '$.agents');
  return target;
}

const legacyLaunchSchema = z.object({ argv: z.array(z.string()).min(1), input: z.unknown().optional(), read: z.unknown(),
  readRoots: z.object({ usage: z.string().min(1).nullable() }).strict(), path: z.string().min(1), values: z.record(z.string(), z.string().min(1)),
}).strict();
// Before 2a8cf5f7e, settled execution snapshots had no package version.
// Absence stays historical evidence; the runnable launch contract remains strict.
const historicalAttemptSchema = z.object({ ...launchSchema.shape, version: launchSchema.shape.version.optional() }).strict()
  .refine(value => value.commandSeconds === undefined || (value.credential === null) === (value.commandSeconds !== null),
    'Only a coordinator launch has command seconds');
const legacyInvocationSchema = z.object({ launch: z.unknown(), mode: z.enum(['start', 'resume']),
  session: z.object({ provider: z.string().nullable(), id: z.string().min(1) }).strict().nullable(),
}).strict();
function launch(input: unknown, path: string, notices: MigrationNotice[]): AgentLaunch {
  const old = checked(legacyLaunchSchema, input, path);
  const id = argvAdapter(old.argv, at(path, 'argv'));
  verifyProtocol(id, old.argv, old.input, old.read, path, notices);
  // Compare against the fixed historical argv AFTER omission of model-dependent groups.
  // An edited tier remains its own extra selection; default4 alone uses fast:null/fast.
  const known = MIGRATION_DEFAULTS.some(d => d.adapter === id && [d.start, d.resume].some(argv =>
    equal(argv.flatMap(word => Array.isArray(word)
      ? word.every(w => [...w.matchAll(/\{([a-z][a-z0-9_]*)\}/g)].every(m => Object.hasOwn(old.values, m[1]!))) ? word : []
      : [word]), old.argv)));
  const values = migrateValues(id, old.values, at(path, 'values'), notices, !known);
  // One pass over the ORIGINAL words: inserted braces are data and are never interpreted again.
  const argv = old.argv.map((word, i) => word.replace(/\{([a-z][a-z0-9_]*)\}/g, (reference, key: string) => {
    if (Object.hasOwn(old.values, key)) return old.values[key]!;
    if (['session', 'result', 'prompt'].includes(key)) return reference;
    return reject(at(at(path, 'argv'), i), 'unknown_reference', 'Historical argv reference has no saved selection or verified system value');
  }));
  if (old.readRoots.usage !== null) notices.push({ path: at(at(path, 'readRoots'), 'usage'), code: 'historical_usage_root_archived',
    reason: 'Historical root is retained in immutable before-image evidence; no reader or execution is reissued' });
  return checked(agentLaunchSchema, { adapter: id, argv, path: old.path, values, env: migratedEnv(id) }, path);
}
export function migrateSavedLaunch(input: unknown, path = '$.launch'): MigrationResult<AgentLaunch> {
  return attempt(notices => launch(input, path, notices));
}
const endedStates = new Set(['succeeded', 'failed', 'cancelled', 'joined']);
function run(input: unknown, path: string, notices: MigrationNotice[]): ObjectValue {
  const old = object(input, path);
  if (!endedStates.has(String(old.state)) || typeof old.ended_at !== 'string')
    reject(at(path, 'state'), 'live_run', 'Only ended Runs can cross the format boundary; needs_review is a blocker');
  if (!['owner', 'worker', 'coordinator'].includes(String(old.role))) reject(at(path, 'role'), 'unknown_role', 'Unknown Run role');
  if (Object.hasOwn(old, 'restartArgv')) reject(at(path, 'restartArgv'), 'already_migrated', 'Expected old format; do not re-migrate a partly converted bundle');
  const target = { ...structuredClone(old), launch: launch(old.launch, at(path, 'launch'), notices),
    ...(old.role === 'coordinator' ? { restartArgv: null } : {}) };
  return object(checked(runtimeRunRecordSchema, target, path), path);
}
export function migrateEndedRun(input: unknown, path = '$.run'): MigrationResult<ObjectValue> {
  return attempt(notices => run(input, path, notices));
}

export type Located<T = unknown> = { path: string; value: T };
/** Slices selected by the existing stopped-migration Owner. No DB handles or publication callbacks.
 * Keep row identities/status/fingerprints/cursors outside the transformed value unchanged.
 * Completeness/quiescence is checked by that Owner at the same stopped read point.
 */
export type AgentMigrationInput = {
  agents: unknown;
  runs: Located[];
  // Nonempty choices need a verified kind, never a profile-name guess or live-config fallback.
  // Empty choices carry no adapter-dependent meaning but still identify their canonical log.
  launchValues: (Located & { profile: string; adapter?: BuiltinAdapterId; preserveSpeed?: boolean })[];
  attempts: (Located & { settled: boolean; prompt?: string })[]; // parsed launch_json; settled from existing execution obligations
};
export type AgentMigrationOutput = {
  agents: Record<string, AgentSetting>; runs: Located<ObjectValue>[];
  launchValues: Located<Selection>[]; attempts: Located<ObjectValue>[];
};
export function isEmptyPlacementSelection(value: unknown): value is Record<string, never> {
  return equal(value, {});
}
/** Saved placement choices require one historical adapter and value representation.
 * Mixed evidence is refused instead of choosing a Run or borrowing a current definition. */
function placementPolicy(records: readonly ObjectValue[], path: string) {
  const launches = records.map(value => checked(runtimeRunRecordSchema, value, path).launch);
  const identities = new Set(launches.map(launch => JSON.stringify([launch.adapter, Object.hasOwn(launch.values, 'speed')])));
  if (identities.size !== 1) reject(path, 'ambiguous_placement_kind', 'Placement lacks one verified historical CLI kind/tier policy');
  const saved = launches[0]!;
  return { adapter: checked(builtinAdapterIdSchema, saved.adapter, path), preserveSpeed: Object.hasOwn(saved.values, 'speed') };
}
export function historicalPlacementPolicy(records: readonly ObjectValue[], path: string) {
  return attempt(() => placementPolicy(records, path));
}
function placementSelections(input: AgentMigrationInput['launchValues'], notices: MigrationNotice[]) {
  return input.map(item => {
    if (isEmptyPlacementSelection(item.value)) return { path: item.path, value: {} };
    const adapter = item.adapter;
    if (!adapter || !Object.hasOwn(AGENT_ADAPTERS, adapter)) reject(item.path, 'unknown_placement_kind', 'Placement choices need verified historical adapter evidence; no live-config fallback');
    return { path: item.path, value: migrateValues(adapter, item.value, item.path, notices, item.preserveSpeed) };
  });
}
export function migratePlacementSelections(input: AgentMigrationInput['launchValues']) {
  return attempt(notices => placementSelections(input, notices));
}
export function dryRunAgentMigration(input: AgentMigrationInput): MigrationResult<AgentMigrationOutput> {
  return attempt(notices => {
    const agents = settings(input.agents, notices);
    const runs = input.runs.map(item => ({ path: item.path, value: run(item.value, item.path, notices) }));
    const launchValues = placementSelections(input.launchValues, notices);
    for (const item of runs) {
      const profile = String(item.value.agent), target = agents[profile];
      if (!target) continue;
      const compiled = compileAgentSetting(profile, target), previous = checked(agentLaunchSchema, item.value.launch, at(item.path, 'launch'));
      if (compiled.adapter !== previous.adapter) continue;
      try { resolveAgentSelection(compiled, {}, previous.values); }
      catch (error) {
        if (!(error instanceof SelectionRequired)) throw error;
        const problems = error.problems.filter(problem => ['speed', 'fast'].includes(problem.key));
        if (problems.length) notices.push({ path: at(at(item.path, 'launch'), 'values'), code: 'continuation_selection_required', problems,
          reason: `Saved Run ${String(item.value.id)} with sealed profile ${profile} requires ${problems.some(problem => problem.recovery === 'new_conversation') ? 'a new conversation' : 'explicit selection'}; one notice per affected saved Run across all history, including coordinator Runs; historical values/argv remain unchanged` });
      }
    }
    const attempts = input.attempts.map(item => {
      if (!item.settled) reject(item.path, 'unsettled_execution', 'Existing execution Owner must resolve obligations/receipts/digests before conversion');
      const old = object(item.value, item.path), invocation = checked(legacyInvocationSchema, old.invocation, at(item.path, 'invocation'));
      const target = { ...structuredClone(old), invocation: {
        ...structuredClone(invocation), launch: launch(invocation.launch, at(at(item.path, 'invocation'), 'launch'), notices),
      } };
      const inlinePrompt = Object.hasOwn(old, 'prompt');
      if (inlinePrompt && item.prompt !== undefined && old.prompt !== item.prompt)
        reject(at(item.path, 'prompt'), 'ambiguous_prompt', 'Inline and canonical Run prompt differ');
      const validated = object(checked(historicalAttemptSchema, inlinePrompt ? target : { ...target, prompt: item.prompt }, item.path), item.path);
      if (!inlinePrompt) delete validated.prompt; // Actual stored launch_json omits the Run-owned prompt.
      return { path: item.path, value: validated };
    });
    // No partial value is exposed if ANY slice rejects. Originals are untouched even on success.
    return { agents, runs, launchValues, attempts };
  });
}
