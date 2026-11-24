/**
 * Each model's context window. The one place it is read and recorded: what a person writes
 * (config.yaml `agents.<profile>.context.<model>`), what the agent itself reported (kept here per kind of agent and
 * model, as it applies to every profile of that kind), and what ships (AGENT_ADAPTERS[kind].contextDefaults). config.yaml
 * is never written here: a person's save would meet a file changed under it, and a reported value would stand as theirs.
 */
import { readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { AGENT_ADAPTERS, builtinAdapterIdSchema } from '@alpacawork/contract/agent-adapters';
import { modelContextSchema, modelKey, resolveContextLimits, type ContextLimits, type ContextUpdate, type ModelContext } from '@alpacawork/contract/agent-context';
import type { ReadRunRecord } from '@alpacawork/contract/run';
import { META_DIRECTORY } from '@alpacawork/raw';
import { readAgentsSettings } from '../agents-settings.js';

const reportedSchema = z.record(z.string(), z.record(z.string(), modelContextSchema));
export type ReportedContexts = z.infer<typeof reportedSchema>;
const file = (root: string) => join(root, META_DIRECTORY, 'context-reported.json');
let cached: { path: string; stamp: string; value: ReportedContexts } | undefined;

/** What agents have reported, by kind and model. A missing or unreadable record is none: the next Run fills it again. */
export function readReportedContexts(root: string): ReportedContexts {
  const path = file(root);
  let stamp: string;
  try { const stat = statSync(path); stamp = `${stat.mtimeMs}:${stat.size}`; } catch { return {}; }
  if (cached?.path === path && cached.stamp === stamp) return cached.value;
  let value: ReportedContexts = {};
  try { value = reportedSchema.parse(JSON.parse(readFileSync(path, 'utf8'))); } catch { /* rebuilt by the next report */ }
  cached = { path, stamp, value };
  return value;
}

/** Keep what an agent said of its model's window; a figure it repeats writes nothing. */
export function recordReportedContext(root: string, adapter: string, model: string | null, update: ContextUpdate): void {
  if (!update.windowTokens) return;
  const all = readReportedContexts(root), key = modelKey(model), before = all[adapter]?.[key] ?? {};
  const next: ModelContext = { ...before, window: update.windowTokens };
  if (next.window === before.window) return;
  const value = { ...all, [adapter]: { ...all[adapter], [key]: next } };
  const path = file(root), temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value));
  renameSync(temporary, path);
}

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
