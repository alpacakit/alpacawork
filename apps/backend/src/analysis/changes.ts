/**
 * Changes in what Runs ran under, read from the Runs themselves: each Run's launch (agent, model, effort) and, when it
 * kept them, its conditions (alpacawork's version, each skill by folder and name, the person's instruction files). One
 * rule for every reader: a value is compared with the last value seen for the same thing in the same place, and a Run
 * whose value differs is the first Run under the new condition. An item added to, or gone from, a set the place had
 * recorded before (the skills of a folder, the instruction files) is a change; the first conditions a place records are
 * not. Where the agent worked (its commit) is left out: it moves with every commit and is the work, not a condition.
 *
 * Readers choose the place a value is compared within (`within`): the timeline compares each placement with itself; the
 * scope-wide read compares what an agent ran under across its Runs, and launch choices within each placement.
 */
import type { AnalysisChange } from '@alpacawork/contract/analysis';
import type { RunConditions } from '@alpacawork/contract/run';

export type ChangeWhat = AnalysisChange['what'];
export type ChangeRun = { id: string; task: string; placement: string; agent: string; model: string | null; effort: string | null;
  started: number | null; conditions: RunConditions | null };
export type ChangeEvent<R extends ChangeRun> = { run: R; previous: R | null; changes: AnalysisChange[] };

const ORDER: readonly ChangeWhat[] = ['agent', 'model', 'effort', 'version', 'skill', 'instruction-file'];
/** A thing a Run ran under, by its set (`group`: a skill folder, or the instruction files; null for a single value). */
type Seen = { what: ChangeWhat; name: string | null; value: string | null; group: string | null };

/** What one Run shows of each thing it ran under, and the sets it read whole (a member it did not show is gone). */
function observed(run: ChangeRun): { seen: Seen[]; sets: { what: ChangeWhat; group: string }[] } {
  const seen: Seen[] = [{ what: 'agent', name: null, value: run.agent, group: null }, { what: 'model', name: null, value: run.model, group: null },
    { what: 'effort', name: null, value: run.effort, group: null }];
  const kept = run.conditions;
  if (!kept) return { seen, sets: [] };
  seen.push({ what: 'version', name: null, value: kept.version, group: null });
  for (const folder of kept.skills) for (const item of folder.items)
    seen.push({ what: 'skill', name: `${folder.scope}:${item.name}`, value: item.digest ?? 'unread', group: folder.folder });
  for (const file of kept.instructions) seen.push({ what: 'instruction-file', name: file.path, value: file.digest, group: '' });
  return { seen, sets: [...kept.skills.map(folder => ({ what: 'skill' as const, group: folder.folder })), { what: 'instruction-file', group: '' }] };
}

/** Each Run (in the order they started) whose conditions differ from the last seen in the same place, with what changed. */
export function changeEvents<R extends ChangeRun>(runs: readonly R[], within: (run: R, what: ChangeWhat) => string): ChangeEvent<R>[] {
  // The last value of each thing, by place: single values by key, set members by their set.
  const singles = new Map<string, string | null>(), sets = new Map<string, Map<string, string>>();
  const recorded = new Set<string>(), lastRun = new Map<string, R>(), events: ChangeEvent<R>[] = [];
  const started = runs.filter(run => run.started !== null)
    .sort((a, b) => a.started! - b.started! || Number(a.id.slice(1)) - Number(b.id.slice(1)));
  for (const run of started) {
    const changes: AnalysisChange[] = [], { seen, sets: read } = observed(run);
    const members = new Map<string, Map<string, string>>();
    for (const item of seen) {
      const place = within(run, item.what);
      if (item.group === null) {
        const key = `${place}\u0000${item.what}`;
        if (singles.has(key) && singles.get(key) !== item.value) changes.push({ what: item.what, name: null, from: singles.get(key)!, to: item.value });
        singles.set(key, item.value);
        continue;
      }
      const set = `${place}\u0000${item.what}\u0000${item.group}`;
      let shown = members.get(set);
      if (!shown) members.set(set, shown = new Map());
      shown.set(item.name!, item.value!);
    }
    for (const { what, group } of read) {
      const place = within(run, what), set = `${place}\u0000${what}\u0000${group}`;
      const before = sets.get(set), now = members.get(set) ?? new Map<string, string>();
      // A set this place recorded before (this folder, or the conditions of this place at all) compares item by item.
      const known = before !== undefined || recorded.has(`${place}\u0000${what}`);
      if (known) {
        for (const [name, value] of now) if (before?.get(name) !== value) changes.push({ what, name, from: before?.get(name) ?? null, to: value });
        for (const [name, value] of before ?? []) if (!now.has(name)) changes.push({ what, name, from: value, to: null });
      }
      sets.set(set, now);
      recorded.add(`${place}\u0000${what}`);
    }
    const seat = within(run, 'agent'), previous = lastRun.get(seat) ?? null;
    lastRun.set(seat, run);
    if (changes.length) events.push({ run, previous,
      changes: changes.sort((a, b) => ORDER.indexOf(a.what) - ORDER.indexOf(b.what) || (a.name ?? '').localeCompare(b.name ?? '')) });
  }
  return events;
}
