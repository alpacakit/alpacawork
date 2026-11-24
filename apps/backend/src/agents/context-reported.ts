/**
 * What agents have reported of their models' context windows, kept per kind of agent and model, as it applies to every
 * profile of that kind. Apart from the settings, so a Run's manager can keep a report without reading them
 * (agents/context-limits reads all three sources).
 */
import { readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { modelContextSchema, modelKey, type ContextUpdate, type ModelContext } from '@alpacawork/contract/agent-context';
import { META_DIRECTORY } from '@alpacawork/raw';

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
