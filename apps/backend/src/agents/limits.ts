/**
 * What the screen knows of each agent's plan limits. The one place they are read, kept and ordered: each adapter only
 * says how its agent reports them (`AgentAdapter.limits`). An agent is asked only while someone reads, at most once per
 * `freshMs`, within the agents' check deadline, or at once when the screen asks to refresh; a read returns what is known
 * at once and refreshes behind it, and waits only for an agent never read yet or a refresh.
 * Accounts are per kind of agent (profiles share the server's sign-in), so the first profile of each kind is asked.
 */
import { AGENT_ADAPTERS, type BuiltinAdapterId } from '@alpacawork/contract/agent-adapters';
import { limitsReportSchema, type AgentLimits, type AgentLimitsResponse, type LimitsReport, type LimitsStackRow } from '@alpacawork/contract/agent-limits';
import { AGENT_CHECK_MS } from '@alpacawork/contract';
import { defaultAiStack } from '../ai-stack.js';
import { enabledAgents, settingAdapter, type AgentSetting } from '@alpacawork/contract/agent-settings';
import type { AgentsSettings } from '../agents-settings.js';
import { runtimeAdapter } from './registry.js';
import type { LimitsProbe } from './adapters/types.js';
import { commandPrefix, launchCommand } from './availability.js';
import { probe, probeArgv, type InspectionEnvironment } from './probe.js';

export const LIMITS_FRESH_MS = 5 * 60_000;
/** Claude's first stream lines list its tools and skills before the answer. */
const LIMITS_OUTPUT = 1024 * 1024;

export type LimitsConfig = Pick<AgentsSettings, 'agents' | 'aiStack'>;
type Known = { limits: AgentLimits; at: number };

/** Kinds of agent in the order the screen lists them: the task stack's, then the other enabled profiles'. */
export function limitsAgents(config: LimitsConfig): [BuiltinAdapterId, AgentSetting][] {
  const enabled = enabledAgents(config.agents);
  const ordered = [...(config.aiStack ?? []).flatMap(row => enabled.filter(([key]) => key === row.agent)), ...enabled];
  const kinds = new Map<BuiltinAdapterId, AgentSetting>();
  for (const [key, setting] of ordered) {
    const kind = settingAdapter(key, setting);
    if (kind && !kinds.has(kind)) kinds.set(kind, setting);
  }
  return [...kinds];
}

/** The rows tasks run on (`defaultAiStack`), enabled agents only, as the kind of agent and the model each launches. */
export function limitsStack(config: LimitsConfig): LimitsStackRow[] {
  const enabled = new Map(enabledAgents(config.agents));
  return defaultAiStack(config).flatMap(row => {
    const setting = enabled.get(row.agent), adapter = setting && settingAdapter(row.agent, setting);
    const model = row.values.model;
    return adapter ? [{ adapter, model: typeof model === 'string' && model ? model : null }] : [];
  });
}

/** Every agent's answer passes the same contract; an account name the contract refuses is dropped, not the limits. */
function checkedReport(report: unknown): LimitsReport | null {
  if (report === null || typeof report !== 'object') return null;
  const whole = limitsReportSchema.safeParse(report);
  if (whole.success) return whole.data;
  const windows = limitsReportSchema.safeParse({ ...report, account: null });
  return windows.success ? windows.data : null;
}

export class AgentLimitsMonitor {
  private readonly known = new Map<string, Known>();
  private readonly pending = new Map<string, Promise<Known>>();

  constructor(private readonly options: { config: () => Promise<LimitsConfig | null>; environment?: InspectionEnvironment;
    now?: () => number; freshMs?: number }) {}

  /** `fresh`: asked from the screen's refresh: every agent is asked again now and the answer waits for them. */
  async read({ fresh = false }: { fresh?: boolean } = {}): Promise<AgentLimitsResponse> {
    const config = await this.options.config();
    if (!config) return { agents: [], stack: [] };
    return { agents: await Promise.all(limitsAgents(config).map(([id, setting]) => this.agent(id, setting, fresh))), stack: limitsStack(config) };
  }

  private async agent(id: BuiltinAdapterId, setting: AgentSetting, fresh: boolean): Promise<AgentLimits> {
    const reader = runtimeAdapter(id)?.limits;
    if (!reader) return { adapter: id, state: 'unsupported', windows: [], account: null, observedAt: null };
    const environment = this.options.environment ?? { cwd: process.cwd(), env: process.env };
    const description = AGENT_ADAPTERS[id];
    let command: string | undefined;
    try { command = launchCommand(id, setting, environment.env.PATH ?? ''); }
    catch { return { adapter: id, state: 'unavailable', windows: [], account: null, observedAt: null }; }
    // The launch prefix the agent runs under, with the bundled bridge in place of its name.
    const prefix = commandPrefix(id, command);
    const argv = description.prefix.length === 1 ? prefix : [...probeArgv(id, null, environment), ...prefix.slice(description.prefix.length)];
    const names = [...description.fixedEnv, ...(setting.env ?? description.defaultEnv)].sort();
    const key = JSON.stringify([argv, names]);
    const now = this.now(), known = this.known.get(key);
    if (!fresh && known && now - known.at < (this.options.freshMs ?? LIMITS_FRESH_MS)) return known.limits;
    let refresh = this.pending.get(key);
    if (!refresh) {
      refresh = this.ask(key, id, [...argv, ...reader.args], names, environment, reader, known)
        .finally(() => this.pending.delete(key));
      this.pending.set(key, refresh);
    }
    return known && !fresh ? known.limits : (await refresh).limits;
  }

  private async ask(key: string, id: BuiltinAdapterId, argv: string[], names: string[], environment: InspectionEnvironment,
    reader: LimitsProbe, known: Known | undefined): Promise<Known> {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), AGENT_CHECK_MS);
    try {
      const result = await probe(argv, environment, names, controller.signal, { input: reader.input, limit: LIMITS_OUTPUT });
      const report = !result.failed && result.status === 0 ? checkedReport(reader.read(result.stdout)) : null;
      const at = this.now();
      // A failed read keeps what was last read: its time says how old it is. Asked again after `freshMs`.
      const next: Known = report ? { at, limits: { adapter: id, state: 'ok', ...report, observedAt: new Date(at).toISOString() } }
        : { at, limits: known?.limits ?? { adapter: id, state: 'unavailable', windows: [], account: null, observedAt: null } };
      this.known.set(key, next);
      return next;
    } finally { clearTimeout(timer); }
  }

  private now(): number { return this.options.now?.() ?? Date.now(); }
}
