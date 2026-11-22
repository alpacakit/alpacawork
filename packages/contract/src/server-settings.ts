import { aiStackSchema } from './ai-stack.js';
import { agentSettingShapeSchema, agentSettingsSchema, paramsSchema } from './agent-settings.js';
import { AGENT_ADAPTERS, BUILTIN_ADAPTER_IDS, builtinAdapterIdSchema, optionsBase } from './agent-adapters.js';
import { problemErrorSchema } from './problem.js';
/**
 * config.yaml as the screen edits it, and the one set of rules that keeps it working: the screen
 * checks a draft with them before saving, and the backend checks every read and write with them.
 */
import { LineCounter, parseDocument } from 'yaml';
import { z } from 'zod';
import { digestSchema } from './fields.js';

/** Coordinator limits apply only to screen Runs: the whole turn in minutes, each command in seconds. */
export const DEFAULT_LIMITS = Object.freeze({
  parallel: 8, run_minutes: 0, depth: 8, children_per_run: 200, automatic_per_placement: 20, attachment_mib: 50,
  coordinator_run_minutes: 30, coordinator_command_seconds: 10,
});
export const LIMIT_KEYS = Object.keys(DEFAULT_LIMITS) as (keyof typeof DEFAULT_LIMITS)[];
export const LIMIT_MINIMUM = Object.freeze({
  parallel: 1, run_minutes: 0, depth: 1, children_per_run: 1, automatic_per_placement: 0, attachment_mib: 1,
  coordinator_run_minutes: 1, coordinator_command_seconds: 1,
}) satisfies Record<keyof typeof DEFAULT_LIMITS, number>;
/**
 * The backend holds a whole file in memory while it receives, compares and serves it, and the framed
 * HTML view decodes it to one string (V8 stops near 512 MiB). The receiver's request deadline is set
 * for the default on a slow link; a larger limit needs a faster one.
 */
export const LIMIT_MAXIMUM = Object.freeze({ attachment_mib: 500 }) satisfies Partial<Record<keyof typeof DEFAULT_LIMITS, number>>;
const limit = (key: keyof typeof DEFAULT_LIMITS) => key === 'run_minutes'
  ? z.number().finite().min(LIMIT_MINIMUM[key])
  : key === 'attachment_mib' ? z.number().int().min(LIMIT_MINIMUM[key]).max(LIMIT_MAXIMUM[key])
    : z.number().int().min(LIMIT_MINIMUM[key]);
/** One attached, written or shown file at most this many bytes. */
export const attachmentBytes = (limits: Pick<Limits, 'attachment_mib'>) => limits.attachment_mib * 1024 * 1024;
/** What the backend may ever read into memory for one file, whatever the setting is now. */
export const MAX_FILE_BYTES = attachmentBytes({ attachment_mib: LIMIT_MAXIMUM.attachment_mib });
/** The one rule for each limit; the backend adds the defaults, the screen sends them all. */
export const limitsShape = Object.fromEntries(LIMIT_KEYS.map(key => [key, limit(key)])) as
  Record<keyof typeof DEFAULT_LIMITS, z.ZodNumber>;
export type Limits = { [K in keyof typeof DEFAULT_LIMITS]: number };
/** The product's name: what the screen is called when no one top project names it. */
export const DEFAULT_PROJECT_NAME = 'alpacawork';
/** The part of config.yaml a config/set writes besides the agents block. */
export const configEditSchema = z.object({ limits: z.object(limitsShape).strict(), aiStack: aiStackSchema.optional(), /* jev: jevSettingsSchema.optional() */ }).strict();

/** The fields the settings' Server tab edits: config/set saves the limits, Jev and the agents block. */
export const serverFormSchema = z.object({
  // jev: jevFormSettingsSchema, // Initial release.
  limits: z.object(limitsShape).strict(),
  agentsText: z.string(),
}).superRefine((draft, context) => {
  addAgentsIssues(draft.agentsText, context);
});
/** Strict settings are validated in the context of their profile key. */
export const agentSchema = agentSettingShapeSchema;
export const agentsSchema = agentSettingsSchema;
type Agents = z.infer<typeof agentsSchema>;
type AgentsIssueKind = 'yaml' | 'top' | 'type' | 'empty' | 'unknownKey' | 'value' | 'name' | 'shape';

type AgentsIssue = { line: number | null; path: string; kind: AgentsIssueKind; detail?: string; message: string };
const kindOf = (issue: z.core.$ZodIssue): { kind: AgentsIssueKind; detail?: string } => {
  if (issue.code === 'custom') return (issue.params?.kind ? issue.params : { kind: 'shape' }) as { kind: AgentsIssueKind; detail?: string };
  if (issue.path.length === 0) return { kind: 'top' };
  if (issue.code === 'invalid_type') return { kind: 'type', detail: issue.expected };
  if (issue.code === 'too_small') return { kind: 'empty' };
  if (issue.code === 'unrecognized_keys') return { kind: 'unknownKey', detail: issue.keys.join(', ') };
  if (issue.code === 'invalid_value') return { kind: 'value', detail: issue.values.map(String).join(', ') };
  if (issue.code === 'invalid_key') return { kind: 'name', detail: String(issue.path.at(-1) ?? '') };
  return { kind: 'shape' };
};
/**
 * Checks the `agents:` block exactly as written (the screen's text area, or the block a save would
 * put into config.yaml). Every problem names its line, so the writer can find it.
 */
function checkAgentsDocument(text: string, full: boolean): { agents: Agents; issues: [] } | { agents: null; issues: AgentsIssue[] } {
  const lineCounter = new LineCounter();
  const document = parseDocument(text, { uniqueKeys: true, lineCounter });
  const broken = [...document.errors, ...document.warnings];
  if (broken.length) return { agents: null, issues: broken.map(error => ({ line: error.linePos?.[0].line ?? null, path: '',
    kind: 'yaml', detail: error.message.split('\n')[0], message: error.message })) };
  let value: unknown;
  try { value = document.toJS({ maxAliasCount: 0 }); }
  catch (error) { return { agents: null, issues: [{ line: null, path: '', kind: 'yaml', message: String(error) }] }; }
  const parsed = (full ? z.object({ agents: agentsSchema }).passthrough() : z.object({ agents: agentsSchema }).strict()).safeParse(value);
  if (parsed.success) return { agents: parsed.data.agents, issues: [] };
  return { agents: null, issues: parsed.error.issues.map(issue => {
    let node: unknown;
    for (let path = [...issue.path]; path.length && !node; path.pop()) node = document.getIn(path as (string | number)[], true);
    const offset = (node as { range?: [number] } | undefined)?.range?.[0] ?? (issue.path.length ? undefined : 0);
    return { line: offset === undefined ? null : lineCounter.linePos(offset).line, path: issue.path.join('.'),
      ...kindOf(issue), message: issue.message };
  }) };
}
export function checkAgentsText(text: string): { agents: Agents; issues: [] } | { agents: null; issues: AgentsIssue[] } {
  return checkAgentsDocument(text, false);
}
/** What the screen's form and config/set both report for a refused agents block, at the field the screen draws them under. */
export function addAgentsIssues(text: string, context: z.RefinementCtx): void {
  for (const problem of checkAgentsText(text).issues)
    context.addIssue({ code: 'custom', path: ['agentsText'], message: problem.message,
      params: { kind: problem.kind, ...(problem.line === null ? {} : { line: problem.line }) } });
}
/** Validate agents against the original complete YAML so CLI errors use real line numbers. */
export function checkAgentsConfigText(text: string): { agents: Agents; issues: [] } | { agents: null; issues: AgentsIssue[] } {
  return checkAgentsDocument(text, true);
}

/** Read-only adapter metadata, derived from the built-in catalog. */
export const adapterCatalogEntrySchema = z.object({
  id: builtinAdapterIdSchema, command: z.string().nullable(), prefix: z.array(z.string()),
  params: paramsSchema, env: agentSettingShapeSchema.shape.env.unwrap(),
  options: z.object({ start: z.string(), resume: z.string() }).strict(),
  optionsBase: digestSchema, referenceUrl: z.string(),
}).strict();
export const adapterCatalogSchema = z.array(adapterCatalogEntrySchema);
export function adapterCatalog(): z.infer<typeof adapterCatalogSchema> {
  return BUILTIN_ADAPTER_IDS.map(id => {
    const adapter = AGENT_ADAPTERS[id];
    return { id, command: adapter.command, prefix: [...adapter.prefix], options: { ...adapter.options },
      params: Object.fromEntries(Object.entries(adapter.defaultParams).map(([key, values]) => [key, [...values]])),
      env: [...adapter.defaultEnv],
      optionsBase: optionsBase(id), referenceUrl: adapter.referenceUrl };
  });
}

/** How long the server spends on all agents' executable and sign-in checks for one answer, at most. */
export const AGENT_CHECK_MS = 10_000;
/** How long a reader of those checks waits: the server's bound plus time for the answer to arrive, so it is never cut
 * short while the server is still within its bound. */
export const AGENT_CHECK_READ_MS = AGENT_CHECK_MS + 5_000;
export const agentAvailabilitySchema = z.object({
  command: z.string().nullable(), version: z.string().nullable(),
  candidates: z.array(z.object({ path: z.string(), version: z.string().nullable() }).strict()),
  status: z.enum(['ready', 'signed_out', 'unknown', 'not_found']),
  nextAction: z.string().nullable(), issue: z.string().nullable(),
}).strict();
export type AgentAvailability = z.infer<typeof agentAvailabilitySchema>;
export const agentInspectionSchema = z.object({
  adapter: builtinAdapterIdSchema.optional(), command: agentSettingShapeSchema.shape.command,
  /** Host observations are requested explicitly; ordinary settings reads start no executables. */
  check: z.boolean().optional(),
}).strict().superRefine((value, ctx) => {
  if ((value.adapter === undefined) !== (value.command === undefined))
    ctx.addIssue({ code: 'custom', path: ['command'], message: 'adapter and command must be supplied together' });
  if (value.adapter && !value.check) ctx.addIssue({ code: 'custom', path: ['check'], message: 'Executable inspection requires check' });
  if (value.adapter && value.command !== undefined && AGENT_ADAPTERS[value.adapter].command === null)
    ctx.addIssue({ code: 'custom', path: ['command'], message: 'This adapter uses a bundled runtime and does not accept command' });
});

/** config.yaml's limits and agents block; `hash` is the file's, so a save refuses a file changed since this read. */
export const serverSettingsSchema = z.object({
  // jev: jevFormSettingsSchema, // Initial release.
  hash: digestSchema.nullable(),
  limits: z.object(limitsShape).strict(),
  /** The `agents:` block of config.yaml as written, comments included. */
  agentsText: z.string(),
  /** Effective values at the time of the read or save. */
  agents: agentsSchema,
  /** The saved AI stack, absent until it has been configured. */
  aiStack: aiStackSchema.optional(),
  catalog: adapterCatalogSchema,
  availability: z.record(z.string(), agentAvailabilitySchema).optional(),
  detected: z.record(z.string(), agentAvailabilitySchema).optional(),
  inspected: agentAvailabilitySchema.optional(),
  error: problemErrorSchema.optional(),
}).strict();
export type ServerSettings = z.infer<typeof serverSettingsSchema>;
