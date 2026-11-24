/**
 * Each model's context window. The one place it is resolved: what a person writes (config.yaml
 * `agents.<profile>.context.<model>`), what the agent itself reported (agents/context-reported), and what ships
 * (AGENT_ADAPTERS[kind].contextDefaults). config.yaml is never written here: a person's save would meet a file changed
 * under it, and a reported value would stand as theirs.
 */
import { AGENT_ADAPTERS, builtinAdapterIdSchema } from '@alpacawork/contract/agent-adapters';
import { modelKey, resolveContextLimits, type ContextLimits } from '@alpacawork/contract/agent-context';
import { runFolder, type ReadRunRecord, type RunActivityView } from '@alpacawork/contract/run';
import { readAgentsSettings } from '../agents-settings.js';
import { readRunActivity } from '../runs/activity.js';
import { readReportedContexts } from './context-reported.js';

/** A Run's model's limits: what a person wrote, else what its agent reported, else what ships. */
export function contextLimitsFor(root: string, run: Pick<ReadRunRecord, 'agent' | 'launch'>): ContextLimits {
  const key = modelKey(run.launch.values.model);
  const adapter = builtinAdapterIdSchema.safeParse(run.launch.adapter);
  const settings = readAgentsSettings(root);
  return resolveContextLimits({
    setting: settings.ok ? settings.config.agents[run.agent]?.context?.[key] : undefined,
    reported: readReportedContexts(root)[run.launch.adapter]?.[key],
    default: adapter.success ? AGENT_ADAPTERS[adapter.data].contextDefaults[key] : undefined,
  });
}

/** A working Run's activity for the screen: its fill with its model's window. */
export function readRunActivityView(root: string, run: Pick<ReadRunRecord, 'id' | 'agent' | 'launch'>): RunActivityView | null {
  const activity = readRunActivity(runFolder(root, run.id));
  if (!activity) return null;
  return { ...activity, context: activity.context && { ...activity.context, ...contextLimitsFor(root, run) } };
}
