import type { Query as QueryRecord, QueryClient, QueryKey } from '@tanstack/react-query';
import { admitsRead, captureReadBoundary, readIndex, readMarker, readQuery, readRefused } from './read-model';
import { assessRead, onReadEvent, resources } from './resources';
import { useConnection } from './connection';
import { withinProject } from '@/domain/tasks';
import { gathering, useViewStore } from '@/state/view-store';

type Query = QueryRecord<any, any, any, any>;
/**
 * Why a read is asked for ahead of its reader, the strongest first: a pointer resting on it, the next card, a held read
 * gone old, a row of the home list where it is the user's turn that nothing has been read of yet.
 */
type Intent = 'pointed' | 'next' | 'required' | 'turn';
const RANK: Record<Intent, number> = { pointed: 0, next: 1, required: 2, turn: 3 };
type Wanted = { key: QueryKey; intent: Intent };

export type ReadScheduler = {
  /** A Task was opened in the reader: its view, and its History on the reports pane, are read now, before anything ahead. */
  opened(id: string, history: boolean): void;
  /** The cards that come next (the list's next row, the next questions): read ahead, after what is open. */
  next(ids: readonly string[]): void;
  /** A pointer rests on (or a key or finger chose) a Task's link: its view is read ahead first. */
  pointed(id: string): void;
  stop(): void;
};

const schedulers = new WeakMap<QueryClient, ReadScheduler>();
/** The client's one scheduler; a client without a started one reads nothing ahead. */
export const readScheduler = (client: QueryClient): ReadScheduler | undefined => schedulers.get(client);

/**
 * The one owner of reading ahead. Only five things ask: a Task opened, the next cards, a pointer resting on a link, a
 * held Query whose required version rose, and the home list's rows where it is the user's turn (waiting for a review or
 * an answer) in the project in view that nothing is held of yet: those are the rows opened next. What is opened is read at once and first; everything else is read one at a
 * time after it, never while the tab is in the background or the feed is not live, and only while it still needs a read.
 * A History is read ahead as its newest events alone (an unread or closed window is its newest HISTORY_WINDOW_SIZE).
 */
export function startReadScheduler(client: QueryClient, host: Window = window): () => void {
  const wanted = new Map<string, Wanted>();
  const markers = new WeakMap<Query, string | null>();
  let opening: Promise<unknown> | undefined, running = false, stopped = false;
  const hash = (key: QueryKey) => JSON.stringify(key);
  const root = () => readIndex(client)?.root;
  const viewKey = (id: string) => resources.taskView(root() ?? '', id).queryKey;
  const historyKey = (id: string) => resources.history(root() ?? '', id).queryKey;
  const read = (key: QueryKey) => key[0] === 'task'
    ? client.prefetchQuery({ ...resources.taskView(String(key[1]), String(key[2])), retry: false })
    : client.prefetchQuery({ ...resources.history(String(key[1]), String(key[2])), retry: false });
  /** Whether a read ahead still has something to do now: nothing held, or what is held needs reading again. */
  const due = (key: QueryKey) => {
    const query = readQuery(client, key);
    if (!admitsRead(client, key, captureReadBoundary(client))) return false;
    if (!query) return true;
    return !readRefused(query) && query.state.fetchStatus === 'idle' && assessRead(client, query).needsRead;
  };
  const allowed = () => !stopped && host.document.visibilityState !== 'hidden' && !useConnection.getState().offline
    && useConnection.getState().state === 'live';
  const want = (key: QueryKey, intent: Intent) => {
    if (!root() || key[1] !== root()) return;
    const at = hash(key), held = wanted.get(at);
    if (held && RANK[held.intent] <= RANK[intent]) return;
    wanted.set(at, { key, intent });
  };
  async function pump() {
    if (running) return;
    running = true;
    try {
      while (allowed() && wanted.size) {
        if (opening) { await opening; continue; }
        const [at, next] = [...wanted].sort(([, a], [, b]) => RANK[a.intent] - RANK[b.intent])[0]!;
        wanted.delete(at);
        if (!due(next.key)) continue;
        // One at a time; Query owns the result and its error, so nothing is retried here.
        await read(next.key).catch(() => {});
      }
    } finally { running = false; }
  }
  const scheduler: ReadScheduler = {
    opened(id, history) {
      const index = readIndex(client);
      if (stopped || !index) return;
      const keys = [viewKey(id), ...(history ? [historyKey(id)] : [])];
      for (const key of keys) wanted.delete(hash(key));
      const reads = Promise.allSettled(keys.map(key => read(key)));
      const mine = opening = reads.finally(() => { if (opening === mine) opening = undefined; void pump(); });
    },
    next(ids) {
      for (const id of ids) { want(viewKey(id), 'next'); want(historyKey(id), 'next'); }
      void pump();
    },
    pointed(id) { want(viewKey(id), 'pointed'); void pump(); },
    stop() { stopped = true; wanted.clear(); },
  };
  // The home list can suggest reads only after navigation has chosen to show it. Reads requested by the
  // reader, a pointed link, or a raised version have their own lifetime.
  const homeProject = (view: ReturnType<typeof useViewStore.getState>) =>
    view.navigationReady && !view.analysis && !gathering(view) ? view.project : undefined;
  const wantHomeTurns = () => {
    const project = homeProject(useViewStore.getState());
    if (project === undefined) return;
    const index = readIndex(client);
    if (!index) return;
    const list = { byId: new Map(index.tasks.map(row => [row.id, row])), projects: index.projects };
    for (const row of index.home) {
      if (row.section !== 'review' || !withinProject(row.taskId, project, list)) continue;
      for (const key of [viewKey(row.taskId), historyKey(row.taskId)]) if (readQuery(client, key)?.state.data === undefined) want(key, 'turn');
    }
  };
  const stopView = useViewStore.subscribe((view, before) => {
    if (homeProject(view) === homeProject(before)) return;
    for (const [key, queued] of wanted) if (queued.intent === 'turn') wanted.delete(key);
    wantHomeTurns();
    void pump();
  });
  // A held read whose required version rose, and that no reader shows now, is read again ahead of its reader.
  const stopLive = onReadEvent(client, event => {
    if (event.kind === 'clear') { wanted.clear(); return; }
    if (event.kind !== 'live') return;
    const index = readIndex(client);
    if (!index) return;
    wantHomeTurns();
    for (const query of client.getQueryCache().getAll()) {
      const kind = query.queryKey[0];
      if (kind !== 'task' && kind !== 'task-history' || query.queryKey[1] !== index.root || query.state.data === undefined) continue;
      const marker = readMarker(index, query.queryKey), before = markers.get(query);
      markers.set(query, marker);
      if (before === undefined || before === marker || query.isActive()) continue;
      if (assessRead(client, query).needsRead) want(query.queryKey, 'required');
    }
    void pump();
  });
  // What each read was made against, recorded as it lands, so the next index can say whether that moved.
  const stopCache = client.getQueryCache().subscribe(event => {
    if (event.type !== 'updated' || event.action.type !== 'success') return;
    const index = readIndex(client), kind = event.query.queryKey[0];
    if (index && (kind === 'task' || kind === 'task-history')) markers.set(event.query, readMarker(index, event.query.queryKey));
  });
  const resume = () => { if (host.document.visibilityState !== 'hidden') void pump(); };
  host.document.addEventListener('visibilitychange', resume);
  const stopConnection = useConnection.subscribe(resume);
  schedulers.set(client, scheduler);
  return () => {
    scheduler.stop(); stopLive(); stopView(); stopCache(); stopConnection(); host.document.removeEventListener('visibilitychange', resume);
    if (schedulers.get(client) === scheduler) schedulers.delete(client);
  };
}
