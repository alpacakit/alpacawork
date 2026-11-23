/** Exercise real read builders, retaining their caches across publications on the incremental side. */
import { closedPageScope } from '@alpacawork/contract/control';
import type { PublishedFrame, RecordsReader, Facet } from '@alpacawork/backend/test-dist/receiver/projection-contract.js';
import { projectedView, ProjectedHistory } from '@alpacawork/backend/test-dist/receiver/task-reads.js';
import { ProjectedPages } from '@alpacawork/backend/test-dist/receiver/index-pages.js';
import { trace, type Resource, type DependencyProbe } from './harness.ts';

export interface ReadTrace {
  target: string;
  facet: Facet;
  scope?: DependencyProbe['scope'];
  value: unknown;
  read: (frame: PublishedFrame) => unknown;
  reads: ReturnType<typeof trace>['reads'];
}
export class ReadResources {
  readonly histories = new ProjectedHistory();
  readonly pages = new ProjectedPages();
  private views = new Map<string, ReturnType<typeof projectedView>>();
  read(frame: PublishedFrame, changed?: ReadonlyMap<string, ReadonlySet<Facet>>, traces?: Map<string, ReadTrace>): Resource[] {
    const resources: Resource[] = [];
    const put = <T>(kind: Resource['kind'], id: string, read: (frame: PublishedFrame, readers: ReadResources) => T, proof = id): T => {
      const resourceKind = kind === 'axis' ? 'timeline' : kind;
      let value: T;
      if (traces) {
        const recorded = trace(frame.records, frame.aggregate, (records, aggregate) => read({ ...frame, records, aggregate: aggregate!,
          derived: id => { derivedReads.push({ from: 'derived', method: 'derived', args: [id] }); return frame.derived(id); } }, this));
        value = recorded.value;
        traces.set(`${kind}:${id}`, { target: proof, facet: resourceKind, value, read: point => read(point, new ReadResources()), reads: [...recorded.reads, ...derivedReads],
          ...(['page', 'search', 'timeline'].includes(resourceKind) ? { scope: { kind: resourceKind as 'page' | 'search' | 'timeline', id: proof } } : {}) });
        derivedReads.length = 0;
      } else value = read(frame, this);
      resources.push({ kind, id, value, requiredPv: frame.requiredPv[resourceKind][proof] ?? 0 });
      return value;
    };
    const derivedReads: ReturnType<typeof trace>['reads'] = [];
    for (const id of frame.records.taskIds()) {
      put('view', id, (point, readers) => {
        if (!readers.views.has(id) || !changed || changed.get(id)?.has('view')) readers.views.set(id, projectedView(point, id));
        return readers.views.get(id)!;
      });
      const latest = put('history', id, (point, readers) => readers.histories.read(point, id));
      if (latest.oldestKey) {
        put('history', `${id}:older`, (point, readers) => readers.histories.read(point, id, { mode: 'older', before: latest.oldestKey!, limit: 2 }), id);
        put('history', `${id}:since`, (point, readers) => readers.histories.read(point, id, { mode: 'since', since: latest.oldestKey!, keep: 3 }), id);
        put('history', `${id}:protect`, (point, readers) => readers.histories.read(point, id, { mode: 'protect', since: latest.oldestKey!, protect: latest.oldestKey! }), id);
      }
    }
    const scopes = ['root', ...frame.records.shelf().listed.keys()];
    for (const name of scopes) {
      const scope = name === 'root' ? null : name;
      for (const kind of ['finished', 'shelved'] as const) {
        const key = closedPageScope(kind, null, scope);
        const page = put('page', key, (point, readers) => readers.pages.page(point, kind, null, scope, undefined, 3));
        if (page.nextAfter) put('page', `${key}:next`, (point, readers) => readers.pages.page(point, kind, null, scope, page.nextAfter!, 3), key);
      }
      for (const text of ['Synthetic', 'T2', 'Replay goal', 'no-matching-fictional-value']) {
        const result = put('search', `${name}:${text}`, (point, readers) => readers.pages.search(point, text, scope, undefined, 3), name);
        if (result.nextAfter) put('search', `${name}:${text}:next`, (point, readers) => readers.pages.search(point, text, scope, result.nextAfter!, 3), name);
      }
    }
    // Each listed row's strip and axis: what changes in one must raise that row's version.
    const shelf = frame.records.shelf();
    for (const id of frame.records.taskIds()) {
      if (!shelf.listed.has(frame.records.projectOf(id))) continue;
      put('timeline', id, (point, readers) => readers.pages.timeline(point, { lanes: id,
        from: '2026-01-01T00:00:00Z', to: '2027-01-01T00:00:00Z' }).lanes[0] ?? null);
      put('axis', id, (point, readers) => readers.pages.timelineAxis(point, { scope: 'root', lanes: id, folded: '' }));
    }
    for (const id of frame.records.taskIds()) put('page', closedPageScope('finished', id, null), (point, readers) => readers.pages.finished(point, id, null, undefined, 3));
    return resources;
  }
}

/** Everything needed for a full-load comparison, including reverse relations that may affect a later write. */
export function recordsMeaning(records: RecordsReader) {
  const ids = [...records.taskIds()].sort();
  return { tasks: ids.map(id => ({ id, bundle: records.bundle(id), parent: records.parent(id), children: records.children(id),
    ancestors: records.ancestors(id), subtree: [...records.subtree(id)], project: records.projectOf(id), scopes: records.scopes(id),
    dependents: records.dependents(id), senders: records.sendersTo(id), targets: records.targetsFromAll(id),
    causes: records.returnsByCauseTask(id), questions: records.questionsByDestination(id), history: records.historyReferrers(id),
    schema: records.schemaOf(records.projectOf(id)) })),
    runs: ids.flatMap(id => records.bundle(id)!.runs.map(run => ({ id: run.id, run: records.run(run.id), owner: records.runOwner(run.id),
      referrers: records.runReferrers(run.id), messages: records.joinedMessages(run.id) }))),
    placements: ids.flatMap(id => records.bundle(id)!.placements.map(p => [p.id, records.placementOwner(p.id), records.placementWritesTo(p.id)])),
    requests: ids.flatMap(id => records.bundle(id)!.requests.map(q => [q.id, records.requestOwner(q.id), records.runByRequest(q.id),
      records.closedRequest(q.id), records.deliveriesByWakeRequest(q.id)])),
    catalog: records.catalog(), projects: records.shelf().catalog(), environment: records.environment(), settings: records.seatSettings() };
}

export function tracedReads(frame: PublishedFrame) {
  const traces = new Map<string, ReadTrace>();
  new ReadResources().read(frame, undefined, traces);
  return traces;
}
