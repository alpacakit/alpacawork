/** Target launch contracts, prepared in stage 1; run-contract/run-protocol switch together in stage 3.
 * argv, values and env are admission facts, never recomputed from live settings.
 * argv starts with a literal executable/bridge prefix, then quote-free option words with references retained.
 * values freezes selected values; only system values remain to be supplied at execution.
 * resolveAgentLaunchArgv substitutes option references from both namespaces in ONE pass, never again.
 */
import { z } from 'zod';
import { AGENT_ADAPTERS, LAUNCH_MODES, type BuiltinAdapterId } from './agent-adapters.js';
import { selectionSchema, type CompiledAgentSetting } from './agent-settings.js';
import { prepareLaunchOptions, resolveLaunchArgv } from './launch-options.js';
import type { SystemVariableName } from './agent-variables.js';
import { resolveAgentSelection, type AgentChoice, type ResolvedAgentSelection } from './agent-selection.js';
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
/** The executable, bridge identity and pinned command are literal admission facts. Only editable options contain
 * references; execution and read-only catalogs resolve those options through the same boundary, exactly once. */
export function resolveAgentLaunchArgv(launch: Pick<AgentLaunch, 'argv' | 'values'>,
  system: Readonly<Partial<Record<SystemVariableName, string>>>): string[] {
  const prefix = launch.argv[0] === 'alpacawork-agent' ? launch.argv[2] === '--command' ? 4 : 2 : 1;
  return [...launch.argv.slice(0, prefix), ...resolveLaunchArgv(launch.argv.slice(prefix), launch.values, system)];
}
/** No restartArgv in the manager-facing invocation or shared launch. mode describes this execution. */
export const agentInvocationSchema = z.object({ mode: launchModeSchema, launch: agentLaunchSchema }).strict();
export type AgentInvocation = z.infer<typeof agentInvocationSchema>;
/** Composed only into CoordinatorRunRecord, at its root. Saved once and immutable after admission.
 * Resume admission computes start argv from the SAME selections for a first-failure restart.
 * Normal start / migrated ended coordinator runs have null. Members never compose this extension.
 * A fresh restart creates a mode=start invocation, without mutating the saved resume launch/restartArgv.
 */
export const coordinatorRestartSchema = z.object({ restartArgv: launchArgvSchema.nullable() }).strict();
export type CoordinatorRestart = z.infer<typeof coordinatorRestartSchema>;

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
  z.object({ ...admissionFields, mode: z.literal('resume'),
    previous: z.object({ adapter: z.string().min(1), values: selectionSchema }).strict(),
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
  const resolved = resolveAgentSelection(compiled, admission.explicit,
    admission.mode === 'resume' ? admission.previous.values : admission.initial);
  return { admission, resolved };
}
function snapshot(compiled: CompiledAgentSetting, admission: LaunchAdmission, resolved: ResolvedAgentSelection): AgentLaunch {
  const adapter = AGENT_ADAPTERS[compiled.adapter];
  const argv = [...adapter.prefix, ...prepareLaunchOptions(compiled.options[admission.mode], resolved.effective, adapter.system[admission.mode])];
  return agentLaunchSchema.parse({ adapter: compiled.adapter, argv, path: admission.path,
    values: resolved.values, env: [...adapter.fixedEnv, ...compiled.setting.env] });
}
/** Pure snapshot preparation for the future backend launchSnapshot owner.
 * Config has already been read/validated; no caller can silently default a stale conversation here.
 * argv retains option references until resolveAgentLaunchArgv, so braces inside selected values remain literal.
 */
export function prepareAgentLaunch(compiled: CompiledAgentSetting, admission: LaunchAdmission): { launch: AgentLaunch; choices: AgentChoice[] } {
  const valid = resolveAdmission(compiled, admission);
  return { launch: snapshot(compiled, valid.admission, valid.resolved), choices: valid.resolved.choices };
}

/** Live coordinator admission: a resume must capture its fresh-start alternative now.
 * The saved-record extension above also accepts null for migrated ended records.
 */
export const coordinatorLaunchAdmissionSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('start'), launch: agentLaunchSchema, restartArgv: z.null() }).strict(),
  z.object({ mode: z.literal('resume'), launch: agentLaunchSchema, restartArgv: launchArgvSchema }).strict(),
]);
export type CoordinatorLaunchAdmission = z.infer<typeof coordinatorLaunchAdmissionSchema>;
export function prepareCoordinatorLaunch(compiled: CompiledAgentSetting, admission: LaunchAdmission): CoordinatorLaunchAdmission {
  const valid = resolveAdmission(compiled, admission);
  const launch = snapshot(compiled, valid.admission, valid.resolved);
  const adapter = AGENT_ADAPTERS[compiled.adapter];
  const restartArgv = valid.admission.mode === 'start' ? null : [...adapter.prefix,
    ...prepareLaunchOptions(compiled.options.start, valid.resolved.effective, adapter.system.start)];
  return coordinatorLaunchAdmissionSchema.parse({ mode: valid.admission.mode, launch, restartArgv });
}
