/** Target launch contracts, prepared in stage 1; run-contract/run-protocol switch together in stage 3.
 * argv, values and env are admission facts, never recomputed from live settings.
 * argv starts with a literal executable/bridge prefix, then quote-free option words with references retained.
 * values freezes selected values; only system values remain to be supplied at execution.
 * resolveAgentLaunchArgv substitutes option references from both namespaces in ONE pass, never again.
 */
import { z } from 'zod';
import { AGENT_ADAPTERS, LAUNCH_MODES, type BuiltinAdapterId } from './agent-adapters.js';
import { launchArgumentValuesSchema, selectionSchema, type CompiledAgentSetting, type Selection } from './agent-settings.js';
import { appliedLaunchValues, optionReferences, prepareLaunchOptions, resolveLaunchArgv } from './launch-options.js';
import type { SystemVariableName } from './agent-variables.js';
import { effectiveAgentValues, resolveAgentSelection, selectionOffer, SelectionRequired, type AgentChoice, type ResolvedAgentSelection,
  type SelectionProblem } from './agent-selection.js';
import { agentEnvironmentNamesSchema } from './agent-environment.js';
export const launchModeSchema = z.enum(LAUNCH_MODES);
export const launchArgvSchema = z.array(z.string()).min(1).refine(argv => argv.length === 0 || argv[0]!.length > 0, 'Executable must not be empty');
export const agentLaunchSchema = z.object({
  // Stored and exchanged identities survive changes to the executable catalog.
  adapter: z.string().min(1),
  argv: launchArgvSchema,
  path: z.string().min(1), values: selectionSchema,
  env: agentEnvironmentNamesSchema,
}).strict();
export type AgentLaunch = z.infer<typeof agentLaunchSchema>;
const optionsOffset = (argv: readonly string[]) =>
  argv[0] === 'alpacawork-agent' ? argv[2] === '--command' ? 4 : 2 : 1;
/** The executable, bridge identity and pinned command are literal admission facts. Only editable options contain
 * references; execution and read-only catalogs resolve those options through the same boundary, exactly once. */
export function resolveAgentLaunchArgv(launch: Pick<AgentLaunch, 'argv' | 'values'>,
  system: Readonly<Partial<Record<SystemVariableName, string>>>): string[] {
  const prefix = optionsOffset(launch.argv);
  return [...launch.argv.slice(0, prefix), ...resolveLaunchArgv(launch.argv.slice(prefix), launch.values, system)];
}
export function appliedAgentLaunchValues(launch: Pick<AgentLaunch, 'argv' | 'values'>): Selection {
  return appliedLaunchValues(launch.argv.slice(optionsOffset(launch.argv)), launch.values);
}
export type AppliedLaunchChoices = { values: Selection; applied: Selection };
/** An omitted option can inherit a previously applied value while the model and choice stay the same. */
export function carriedAgentLaunchValues(values: Selection, previous: AppliedLaunchChoices): Selection {
  return previous.values.model === values.model
    ? Object.fromEntries(Object.entries(previous.applied).filter(([key, value]) => values[key] === value)) : {};
}
/** Mode describes this execution. */
export const agentInvocationSchema = z.object({ mode: launchModeSchema, launch: agentLaunchSchema }).strict();
export type AgentInvocation = z.infer<typeof agentInvocationSchema>;
export class ConversationAdapterMismatch extends Error {
  readonly code = 'new_conversation_required';
  constructor(readonly previous: string, readonly current: BuiltinAdapterId) {
    super('A conversation cannot resume with a different adapter');
  }
}
const admissionFields = { path: z.string().min(1), explicit: selectionSchema.optional() };
export const launchAdmissionSchema = z.discriminatedUnion('mode', [
  z.object({ ...admissionFields, mode: z.literal('start'), initial: selectionSchema.optional(), previous: z.never().optional() }).strict()
    .superRefine((admission, ctx) => {
      if (Object.hasOwn(admission, 'previous')) ctx.addIssue({ code: 'custom', path: ['previous'],
        message: 'A new conversation must not carry previous values' });
    }),
  z.object({ ...admissionFields, mode: z.literal('resume'), initial: selectionSchema.optional(),
    previous: z.object({ adapter: z.string().min(1), values: selectionSchema, applied: selectionSchema.optional() }).strict(),
  }).strict(),
]);
export type LaunchAdmission = z.infer<typeof launchAdmissionSchema>;
export class InvalidLaunchAdmission extends Error {
  readonly code = 'invalid_launch_admission';
  constructor(readonly issues: z.ZodError['issues']) { super('Invalid launch admission'); }
}
/** Every public preparation path validates the mode/history contract, including JS callers. */
function resolveAdmission(compiled: CompiledAgentSetting, input: LaunchAdmission) {
  const parsed = launchAdmissionSchema.safeParse(input);
  if (!parsed.success) throw new InvalidLaunchAdmission(parsed.error.issues);
  const admission = parsed.data;
  if (admission.mode === 'resume' && admission.previous.adapter !== compiled.adapter)
    throw new ConversationAdapterMismatch(admission.previous.adapter, compiled.adapter);
  let base = admission.initial;
  if (admission.mode === 'resume') {
    // A new starting row replaces current choices. Keep removed keys visible to selection validation.
    base = base === undefined ? admission.previous.values : {
      ...admission.previous.values,
      ...Object.fromEntries(selectionOffer(compiled).choices.map(choice => [choice.key, choice.initial])),
      ...base,
    };
  }
  const resolved = resolveAgentSelection(compiled, admission.explicit, base);
  return { admission, resolved };
}
function snapshot(compiled: CompiledAgentSetting, admission: LaunchAdmission, resolved: ResolvedAgentSelection): AgentLaunch {
  const adapter = AGENT_ADAPTERS[compiled.adapter];
  const argv = [...adapter.prefix, ...prepareLaunchOptions(compiled.options[admission.mode], resolved.effective, adapter.system[admission.mode])];
  return agentLaunchSchema.parse({ adapter: compiled.adapter, argv, path: admission.path,
    values: resolved.values, env: [...adapter.fixedEnv, ...compiled.setting.env] });
}
function assertResumeSelections(previous: Selection, resolved: ResolvedAgentSelection, applied: ReadonlySet<string>,
  carried = previous): void {
  const problems: SelectionProblem[] = [];
  for (const { key, candidates, active } of resolved.choices) {
    const former = Object.hasOwn(previous, key) ? previous[key]! : null;
    const value = resolved.values[key];
    if (!active || applied.has(key) || Object.hasOwn(carried, key) && carried[key] === value || value === null && former === null) continue;
    problems.push({ key, previous: former, candidates, reason: 'unused', recovery: 'new_conversation' });
  }
  if (problems.length) throw new SelectionRequired(problems);
}
/** Pure snapshot preparation for the future backend launchSnapshot owner.
 * Config has already been read/validated; no caller can silently default a stale conversation here.
 * argv retains option references until resolveAgentLaunchArgv, so braces inside selected values remain literal.
 */
export function prepareAgentLaunch(compiled: CompiledAgentSetting, admission: LaunchAdmission): { launch: AgentLaunch; choices: AgentChoice[] } {
  const valid = resolveAdmission(compiled, admission);
  const launch = snapshot(compiled, valid.admission, valid.resolved);
  if (valid.admission.mode === 'resume') {
    const applied = new Set(Object.keys(appliedAgentLaunchValues(launch)));
    // A nullable choice can deliberately omit an option from the resume template.
    for (const key of optionReferences(compiled.options.resume).all)
      if (launch.values[key] === null) applied.add(key);
    const previousEffective = valid.admission.previous.applied ??
      effectiveAgentValues(compiled.setting, valid.admission.previous.values);
    const carried = carriedAgentLaunchValues(valid.resolved.values, { values: valid.admission.previous.values, applied: previousEffective });
    assertResumeSelections(previousEffective, valid.resolved, applied, carried);
  }
  return { launch, choices: valid.resolved.choices };
}

const coordinatorLaunchAdmissionSchema = z.object({
  launch: agentLaunchSchema, appliedValues: launchArgumentValuesSchema, mode: launchModeSchema,
}).strict();
type CoordinatorLaunchAdmission = z.infer<typeof coordinatorLaunchAdmissionSchema>;
export function prepareCoordinatorLaunch(compiled: CompiledAgentSetting, admission: LaunchAdmission): CoordinatorLaunchAdmission {
  const valid = resolveAdmission(compiled, admission);
  const launch = snapshot(compiled, valid.admission, valid.resolved);
  const adapter = AGENT_ADAPTERS[compiled.adapter];
  const appliedValues = appliedLaunchValues(launch.argv.slice(adapter.prefix.length), valid.resolved.effective);
  if (valid.admission.mode === 'resume')
    assertResumeSelections(valid.admission.previous.values, valid.resolved, new Set(Object.keys(appliedValues)));
  return coordinatorLaunchAdmissionSchema.parse({ mode: valid.admission.mode, launch, appliedValues });
}
