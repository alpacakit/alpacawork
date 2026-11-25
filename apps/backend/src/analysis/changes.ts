/**
 * Changes in what Runs ran under, read from the Runs themselves: each Run's launch (agent, model, effort) and, when it
 * kept them, its conditions (alpacawork's version, each skill by folder and name, the person's instruction files). One
 * rule for every reader: a value is compared with the last value seen for the same thing in the same place, and a Run
 * whose value differs is the first Run under the new condition. Where the agent worked (its commit) is left out: it
 * moves with every commit and is the work, not a condition.
 *
 * Readers choose the place a value is compared within (`within`): the timeline compares each seat with itself; the
 * scope-wide read compares what an agent ran under across its Runs, and launch choices within each seat.
 */
import type { AnalysisChange } from '@alpacawork/contract/analysis';
import type { RunConditions } from '@alpacawork/contract/run';

export type ChangeWhat = AnalysisChange['what'];
export type ChangeRun = { id: string; task: string; placement: string; agent: string; model: string | null; effort: string | null;
  started: number | null; conditions: RunConditions | null };
export type ChangeEvent<R extends ChangeRun> = { run: R; previous: R | null; changes: AnalysisChange[] };

const ORDER: readonly ChangeWhat[] = ['agent', 'model', 'effort', 'version', 'skill', 'instructions'];
type Seen = { what: ChangeWhat; name: string | null; value: string | null; group: string | null };

/**
 * What one Run shows of each thing it ran under. A thing read as a group (the skills of a folder, the instruction files)
 * names its group: a member the Run did not show of a group it read is gone.
 */
function observed(run: ChangeRun): { seen: Seen[]; groups: { what: ChangeWhat; group: string }[] } {
  const seen: Seen[] = [{ what: 'agent', name: null, value: run.agent, group: null }, { what: 'model', name: null, value: run.model, group: null },
    { what: 'effort', name: null, value: run.effort, group: null }];
  const kept = run.conditions;
  if (!kept) return { seen, groups: [] };
  seen.push({ what: 'version', name: null, value: kept.version, group: null });
  for (const folder of kept.skills) for (const item of folder.items)
    seen.push({ what: 'skill', name: `${folder.scope}:${item.name}`, value: item.digest ?? 'unread', group: folder.folder });
  for (const file of kept.instructions) seen.push({ what: 'instructions', name: file.path, value: file.digest, group: '' });
  return { seen, groups: [...kept.skills.map(folder => ({ what: 'skill' as const, group: folder.folder })), { what: 'instructions', group: '' }] };
}

/** Each Run (in the order they started) whose conditions differ from the last seen in the same place, with what changed. */
export function changeEvents<R extends ChangeRun>(runs: readonly R[], within: (run: R, what: ChangeWhat) => string): ChangeEvent<R>[] {
  const last = new Map<string, { value: string | null; name: string | null; what: ChangeWhat; group: string | null }>();
  const lastRun = new Map<string, R>(), events: ChangeEvent<R>[] = [];
  const started = runs.filter(run => run.started !== null)
    .sort((a, b) => a.started! - b.started! || Number(a.id.slice(1)) - Number(b.id.slice(1)));
  for (const run of started) {
    const changes: AnalysisChange[] = [], present = new Set<string>(), groups = new Set<string>();
    const { seen, groups: read } = observed(run);
    for (const { what, group } of read) groups.add(JSON.stringify([within(run, what), what, group]));
    for (const item of seen) {
      const place = within(run, item.what), key = JSON.stringify([place, item.what, item.group, item.name]);
      present.add(key);
      const before = last.get(key);
      if (before && before.value !== item.value) changes.push({ what: item.what, name: item.name, from: before.value, to: item.value });
      last.set(key, { value: item.value, name: item.name, what: item.what, group: item.group });
    }
    // A skill gone from a folder this Run read, or an instruction file gone, is a change to nothing.
    for (const [key, before] of last) {
      const [place, what, group] = JSON.parse(key) as [string, ChangeWhat, string | null];
      if (present.has(key) || group === null || !groups.has(JSON.stringify([place, what, group]))) continue;
      changes.push({ what, name: before.name, from: before.value, to: null });
      last.delete(key);
    }
    const seat = within(run, 'agent'), previous = lastRun.get(seat) ?? null;
    lastRun.set(seat, run);
    if (changes.length) events.push({ run, previous,
      changes: changes.sort((a, b) => ORDER.indexOf(a.what) - ORDER.indexOf(b.what) || (a.name ?? '').localeCompare(b.name ?? '')) });
  }
  return events;
}
