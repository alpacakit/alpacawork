/** Complete server answers, built with the existing server-projection fixtures.
 * No receipt is promoted to a full view and no test supplies a read evaluator.
 */
import type { IndexPatchDTO, ProjectedIndexDTO, TaskProjectedViewDTO, TaskRowDTO } from '@alpacawork/contract/control';
import { historyCursor } from '@alpacawork/contract';
import { rowOf, served0, tree, viewsOf } from './fixtures';

/** A Task's opened view as the projection answers it, from `sourcePv` (the fixture index's 0 unless given). */
export function serverView(value: ReturnType<typeof tree>, id: string, _movedAt?: number, sourcePv = 0): TaskProjectedViewDTO {
  return viewsOf(value, sourcePv).find(view => view.task.id === id)!;
}

/** A Task's closed-page row as the server lists it. */
export function serverPageRow(value: ReturnType<typeof tree>, id: string) {
  const { stateLog, ball, question, ...fields } = rowOf(value.tasks.find(task => task.id === id)!, value);
  const stateMark = [...stateLog].reverse().find(entry => entry.toState !== null) ?? null;
  const report = [...stateLog].reverse().find(entry => entry.kind === 'reported') ?? null;
  return { ...fields, ...(ball ? { ball } : {}), ...(question ? { question } : {}), stateMark,
    latestReport: report?.id === stateMark?.id ? null : report,
    childCounts: { live: value.children?.[id]?.live ?? 0, finished: value.children?.[id]?.finished ?? 0 } };
}
/** A closed page answer holding `rows`, from the fixture projection. */
export const serverPage = (rows: unknown[]) => ({ rows, total: rows.length, nextAfter: null, ...served0 });
/** A History window answer holding all of `events` (newest first), from the fixture projection. */
export const historyWindowAnswer = (events: { at: string; taskId: string; id: string; kind: string }[] = []) =>
  ({ ...served0, events, hasOlder: false, oldestKey: events.length ? historyCursor(events.at(-1) as never) : null });

const keyed = () => ({ upsert: {}, remove: [] });
/**
 * The `patch` a server sends after writing `rows`: the rows replaced, at the next projection version, which each written
 * Task's view (and any `requires` named) now requires.
 */
export function serverPatch(index: ProjectedIndexDTO, rows: TaskRowDTO[], requires: Partial<Record<keyof IndexPatchDTO['requiredPv'], string[]>> = {}): IndexPatchDTO {
  const sourcePv = (index.sourcePv + 1) as IndexPatchDTO['sourcePv'];
  const raised = (ids: string[] = []) => ({ upsert: Object.fromEntries(ids.map(id => [id, sourcePv])), remove: [] });
  return { rev: index.rev + 1, generation: index.generation, sourcePv,
    tasks: { upsert: rows, remove: [] }, placements: { upsert: [], remove: [] }, runs: { upsert: [], remove: [] },
    home: { upsert: [], remove: [] },
    counts: { closed: keyed(), home: keyed(), tasks: keyed(), children: keyed() },
    requiredPv: { view: raised([...rows.map(row => row.id), ...requires.view ?? []]), history: raised(requires.history),
      page: raised(requires.page), timeline: raised(requires.timeline), search: raised(requires.search) },
    meta: {} };
}
/** The former name, for callers moving to serverPatch. */
export const serverDelta = serverPatch;

export const jsonAnswer = (value: unknown) => new Response(JSON.stringify(value));
