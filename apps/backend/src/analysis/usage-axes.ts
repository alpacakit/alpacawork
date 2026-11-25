import { createHash } from 'node:crypto';
import type { AnalysisUsageFilters, AnalysisUsageSeriesInput } from '@alpacawork/contract/analysis';
import type { ModelRun } from './rules.js';
import { Kept } from './slices.js';

type Axis = AnalysisUsageSeriesInput['by'];
export type UsageIdentity = { name: string; effort: string | null };

export const recordedModelName = (run: ModelRun, reportedModels: ReadonlyMap<string, string>) =>
  reportedModels.get(run.id) ?? run.model;

export function usageIdentity(run: ModelRun, reportedModels: ReadonlyMap<string, string>): UsageIdentity {
  return { name: recordedModelName(run, reportedModels) ?? run.agent, effort: run.effort };
}

export function matchesUsage({ name, effort }: UsageIdentity, filters: AnalysisUsageFilters) {
  return (filters.model === undefined || filters.model === name) &&
    (filters.effort === undefined || filters.effort === effort) && (!filters.effortMissing || effort === null);
}

const groups = new Kept<string, { key: string; label: string; value: string | null }>(256);
export function usageGroup(axis: Axis, value: string | null) {
  const id = JSON.stringify([axis, value]);
  let group = groups.get(id);
  if (!group) {
    group = { key: createHash('sha256').update(id).digest('base64url'), label: value ?? 'Not recorded', value };
    groups.set(id, group);
  }
  return group;
}
