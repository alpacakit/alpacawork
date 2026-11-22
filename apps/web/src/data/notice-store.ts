import { readQuery, readIndex, serverReadFacts, getReadProof, subscribeReads } from './read-model';
import { readWriteBasis } from './connection';
import type { ProjectedIndexDTO } from '@alpacawork/contract/control';
import type { TaskRowDTO } from '@alpacawork/contract/control';
import { noticeStateResponseSchema } from '@alpacawork/contract';
import { isCancelledError } from '@tanstack/react-query';
import { createStore } from 'zustand/vanilla';
import { createApi, retryOf } from './client';
import { queryClient } from './query-client';
import { resources, fetchAcceptedResource, acceptPersonalRead, captureResourceRead, confirmPersonalRead, readState, sameReadScope, indexKey } from './resources';

import { canSendWrites, useConnection } from './connection';
import { recordFailure } from '@/lib/notify';
import { NOTICE_VERSION, taskBaseline, taskEvents, unseen, type FirstSeen, type NoticeCheckpoint, type NoticeSaved, type TaskBaseline } from './notice-model';

const baselinesFor = (tasks: TaskRowDTO[]) => Object.fromEntries(tasks.map((task) => [task.id, taskBaseline(task)]));

/** true: confirmed effect; false: confirmed missing effect. Cancellation and uncertainty are not failure. */
export type NoticeReadResult = boolean | 'cancelled' | 'unconfirmed';

type NoticeAction = { kind: 'read'; task: TaskRowDTO }
  | { kind: 'confirm'; tasks: TaskRowDTO[] } | { kind: 'undo'; prior: NoticeSaved; revision: string };
type NoticeStore = {
  root?: string;
  status: 'idle' | 'loading' | 'ready' | 'error';
  revision: string | null;
  fresh: boolean;
  serverRevision: string | null;
  checkpoint?: NoticeCheckpoint;
  reads: Record<string, TaskBaseline>;
  undo?: { prior: NoticeSaved; revision: string };
  firstSeen: ReadonlyMap<string, FirstSeen>;
  tasks: TaskRowDTO[];
  bind: (root: string) => void;
  receive: (root: string, tasks: TaskRowDTO[], revision: string | null) => void;
  reload: () => Promise<void>;
  confirm: (tasks: TaskRowDTO[]) => Promise<NoticeReadResult>;
  undoAllRead: () => Promise<boolean>;
  read: (task: TaskRowDTO) => Promise<NoticeReadResult>;
};

/** The single client projection of the server's per-reader checkpoint. */
export function createNoticeStore() {
  const api = createApi();
  let queue = Promise.resolve();
  let syncSeen = () => {};
  const unreadReads = (tasks: TaskRowDTO[], state: NoticeSaved | null) => {
    if (!state) return tasks;
    const baselines = { ...state.checkpoint.tasks, ...state.reads };
    const current = new Map(serverReadFacts(queryClient)?.tasks.map(task => [task.id, task]));
    return tasks.filter(task => {
      const latest = current.get(task.id);
      // A later visit on another device may already have read newer facts. An old queued intent cannot undo it.
      return unseen(task, baselines) && !(latest && latest.version > task.version && !unseen(latest, baselines));
    });
  };
  type PendingRead = { source: Pick<ProjectedIndexDTO, 'root' | 'generation'>; tasks: TaskRowDTO[] };
  type Control = Omit<NoticeStore, 'checkpoint' | 'reads' | 'revision' | 'fresh'> & { pendingReads?: PendingRead[] };
  const controls = createStore<Control>((set) => {
    // Persistence and conflict recovery always use confirmed Query data, never the optimistic projection.
    const get = () => snapshot(false);
    const accept = () => {
      // A revision names one saved state, so a reload that finds the same one changes nothing.
      set({ status: 'ready' });
      updateSeen();
    };
    const updateSeen = () => {
      const { tasks, checkpoint, reads } = get();
      if (!checkpoint) return;
      const firstSeen = new Map(get().firstSeen);
      const now = Date.now();
      const visible = [...taskEvents(tasks, checkpoint.tasks), ...taskEvents(tasks, { ...checkpoint.tasks, ...reads })];
      const ids = new Set(visible.map((event) => event.id));
      let changed = false;
      for (const id of firstSeen.keys()) if (!ids.has(id)) { firstSeen.delete(id); changed = true; }
      for (const event of visible) if (!firstSeen.has(event.id)) { firstSeen.set(event.id, { at: now }); changed = true; }
      if (changed) set({ firstSeen });
    };
    const needsInitialization = () => queryClient.getQueryData<{ state: NoticeSaved | null }>(resources.notices(get().root ?? '').queryKey)?.state === null;
    syncSeen = () => { updateSeen(); if (get().root && needsInitialization() && get().fresh) void refresh(false); };
    const fetchState = async (force = false): Promise<{ state: NoticeSaved | null; revision: string | null;
      initialBaselines?: Record<string, TaskBaseline> }> => {
      const options = resources.notices(get().root ?? '');
      if (force) await queryClient.invalidateQueries({ queryKey: options.queryKey, exact: true, refetchType: 'none' });
      return fetchAcceptedResource(queryClient, options);
    };
    const saveState = async (state: NoticeSaved, expectedRevision: string | null) => {
      const root = get().root;
      const started = captureResourceRead(queryClient, resources.notices(root ?? '').queryKey);
      const response = await api.request('person/notices/save', noticeStateResponseSchema, undefined, { state, expectedRevision }, undefined, readWriteBasis(resources.notices(root ?? '').queryKey, expectedRevision));
      const adopted = !!root && get().root === root && [expectedRevision, response.revision].includes(get().revision)
        && acceptPersonalRead(queryClient, resources.notices(root).queryKey, response, started);
      return { saved: response as { state: NoticeSaved; revision: string }, adopted };
    };
    const refreshDirect = async (force: boolean) => {
      const root = get().root;
      const source = readIndex(queryClient);
      if (!root) return;
      // A revision reload keeps the ready checkpoint on screen; only a first load or retry shows loading.
      if (get().status !== 'ready') set({ status: 'loading' });
      try {
        let latest = await fetchState(force);
        if (get().root !== root) return;
        if (!latest.state && get().fresh) {
          const initial: NoticeSaved = { version: NOTICE_VERSION, checkpoint: { at: new Date().toISOString(),
            tasks: latest.initialBaselines ?? baselinesFor(get().tasks) }, reads: {} };
          try { const receipt = await saveState(initial, null); if (!receipt.adopted) return; latest = receipt.saved; }
          catch (error) { if (retryOf(error) !== 'reread') throw error; recordFailure(error, 'notices first save'); latest = await fetchState(true); }
        }
        if (get().root !== root) return;
        if (!latest.state) { set({ status: 'ready' }); return; }
        accept();
      } catch (error) { if (isCancelledError(error)) return; recordFailure(error, 'notices load'); if (get().root === root && (!source || sameReadScope(queryClient, source))) set({ status: 'error' }); }
    };
    const refresh = (force = true) => {
      if (!queryClient.getQueryData(resources.notices(get().root ?? '').queryKey)) set({ status: 'loading' });
      const result = queue.then(() => refreshDirect(force));
      queue = result.then(() => undefined, () => undefined);
      return result;
    };
    const apply = (state: NoticeSaved, action: NoticeAction): NoticeSaved => {
      if (action.kind === 'read') return { ...state, reads: { ...state.reads, [action.task.id]: taskBaseline(action.task) } };
      if (action.kind === 'confirm') return { version: NOTICE_VERSION, checkpoint: { at: new Date().toISOString(), tasks: {
        ...state.checkpoint.tasks, ...state.reads, ...baselinesFor(action.tasks),
      } }, reads: {} };
      return action.prior;
    };
    const commit = (action: NoticeAction): Promise<NoticeReadResult> => {
      const satisfied = (state: NoticeSaved | null, target?: NoticeSaved) => {
        if (!state) return false;
        if (action.kind === 'read') return unreadReads([action.task], state).length === 0;
        return target !== undefined && JSON.stringify(state) === JSON.stringify(target);
      };
      // Admission precedes queue/pause: an offline action cannot turn into a future send.
      if (!get().fresh) return Promise.resolve('cancelled');
      const source = readIndex(queryClient);
      const pending = source && get().status === 'ready' && get().checkpoint && action.kind === 'read'
        ? { source: { root: source.root, generation: source.generation }, tasks: [action.task] } : undefined;
      // Opening is optimistic.
      // Publish before the first queue microtask, so the click's render already has its read mark.
      if (pending) set(state => ({ pendingReads: [...state.pendingReads ?? [], pending] }));
      const work = async (): Promise<NoticeReadResult> => {
        const root = get().root;
        if (source && !sameReadScope(queryClient, source)) return 'cancelled';
        if (!root || !get().fresh || get().status !== 'ready' || !get().checkpoint) return 'cancelled';
        let latest = { state: { version: NOTICE_VERSION, checkpoint: get().checkpoint!, reads: get().reads }, revision: get().revision };
        const previous = latest.state;
        const left = () => get().root !== root || !!source && !sameReadScope(queryClient, source);
        /** The check itself failed: whether the save landed is unknown, unless this scope is gone. */
        const lostVerify = (error: unknown): NoticeReadResult => {
          recordFailure(error, 'notices verify');
          if (left()) return 'cancelled';
          set({ status: 'error' });
          return 'unconfirmed';
        };
        // A feed GET may overtake a committed POST. Verify its effect, not transport adoption or whole-state equality.
        const verify = async (target: NoticeSaved): Promise<NoticeReadResult> => {
          try {
            const verified = await fetchState(true);
            if (left()) return 'cancelled';
            confirmPersonalRead(queryClient, resources.notices(root).queryKey, verified);
            accept();
            const confirmed = satisfied(verified.state, target);
            if (confirmed && action.kind === 'confirm' && verified.revision)
              set({ undo: { prior: previous, revision: verified.revision } });
            else if (confirmed && action.kind === 'undo') set({ undo: undefined });
            return confirmed;
          } catch (error) { return lostVerify(error); }
        };
        for (let attempt = 0; attempt < 2; attempt++) {
          // The same news predicate owns normal reads, conflict recovery and uncertain delivery.
          if (satisfied(latest.state)) return true;
          if (action.kind === 'undo' && action.revision !== latest.revision) { set({ undo: undefined }); return false; }
          const target = apply(latest.state, action);
          try {
            const receipt = await saveState(target, latest.revision);
            if (left()) return 'cancelled';
            if (!receipt.adopted) return await verify(target);
            const saved = receipt.saved;
            accept();
            if (action.kind === 'confirm') set({ undo: { prior: previous, revision: saved.revision } });
            else if (action.kind === 'undo') set({ undo: undefined });
            return true;
          } catch (error) {
            recordFailure(error, `notices ${action.kind}`);
            if (retryOf(error) === 'reread') {
              try { latest = await fetchState(true) as typeof latest; }
              catch (verifyError) { return lostVerify(verifyError); }
              if (left()) return 'cancelled';
              confirmPersonalRead(queryClient, resources.notices(root).queryKey, latest);
              if (!latest.state) return false;
              accept();
              continue;
            }
            return await verify(target);
          }
        }
        return satisfied(latest.state);
      };
      const result = queue.then(work).finally(() => {
        // Retire only this intent: a failure must not undo another queued click or a remote confirmed read.
        if (pending) set(state => ({ pendingReads: state.pendingReads?.filter(each => each !== pending) }));
      });
      queue = result.then(() => undefined, () => undefined);
      return result;
    };
    // Scope selects the existing personal Query; it never imports Task baselines from display rows.
    const bind = (root: string) => {
      if (get().root !== root) set({ root, tasks: [], serverRevision: null, undo: undefined, firstSeen: new Map(), status: 'loading' });
    };
    return {
      status: 'idle', serverRevision: null, firstSeen: new Map(), tasks: [], pendingReads: [], bind,
      receive: (root, tasks, revision) => {
        bind(root);
        set({ tasks, serverRevision: revision });
        updateSeen();
        if (needsInitialization() && get().fresh) void refresh(false);
      },
      reload: () => refresh(),
      confirm: (tasks) => commit({ kind: 'confirm', tasks }),
      undoAllRead: () => { const undo = get().undo; return undo ? commit({ kind: 'undo', ...undo }).then(result => result === true) : Promise.resolve(false); },
      read: (task) => commit({ kind: 'read', task }),
    };
  });
  const emptyReads: Record<string, TaskBaseline> = {};
  type Snapshot = { control: Control; queryState: unknown; indexState: unknown; connection: unknown; view: NoticeStore };
  const snapshots: { confirmed?: Snapshot; projected?: Snapshot } = {};
  function snapshot(project = true): NoticeStore {
    const slot = project ? 'projected' : 'confirmed', previous = snapshots[slot];
    const control = controls.getState();
    const query = readQuery(queryClient, resources.notices(control.root ?? '').queryKey);
    const indexState = queryClient.getQueryState(['index']), connection = useConnection.getState();
    if (previous?.control === control && previous.queryState === query?.state && previous.indexState === indexState && previous.connection === connection) return previous.view;
    const read = readState<{ state: NoticeSaved | null; revision: string | null; initialBaselines?: Record<string, TaskBaseline> }>(queryClient, resources.notices(control.root ?? '').queryKey);
    const data = read.data;
    const { pendingReads = [], ...display } = control;
    let reads = data?.state?.reads ?? emptyReads;
    if (project) for (const pending of pendingReads) {
      // A list/personal refresh may be temporarily stale, but the acknowledged facts stay read in this scope.
      if (pending.source.root === control.root && sameReadScope(queryClient, pending.source)) {
        const unread = unreadReads(pending.tasks, data?.state ?? null);
        if (unread.length) reads = { ...reads, ...baselinesFor(unread) };
      }
    }
    const view: NoticeStore = { ...display, revision: data?.revision ?? null, checkpoint: data?.state?.checkpoint ?? (data?.initialBaselines && query ? { at: new Date(getReadProof(query)?.acquiredAt ?? 0).toISOString(), tasks: data.initialBaselines } : undefined),
      reads, status: read.status === 'idle' && control.status !== 'ready' ? control.status : read.status,
      fresh: !!serverReadFacts(queryClient) && read.assessment.project && canSendWrites() };
    // An initial checkpoint is derived anew; share it only with the same time and actual baselines.
    if (previous && data?.state == null && data?.initialBaselines
      && view.checkpoint?.at === previous.view.checkpoint?.at && view.checkpoint?.tasks === previous.view.checkpoint?.tasks)
      view.checkpoint = previous.view.checkpoint;
    const kept = previous && Object.keys(view).length === Object.keys(previous.view).length
      && (Object.keys(view) as (keyof NoticeStore)[]).every(key => Object.is(view[key], previous!.view[key])) ? previous.view : view;
    snapshots[slot] = { control, queryState: query?.state, indexState, connection, view: kept }; return kept;
  }
  // This is a UI projection over QueryCache. No setter can replace the checkpoint or reads independently.
  return { getState: () => snapshot(), getInitialState: controls.getInitialState, setState: controls.setState,
    subscribe: (changed: () => void) => {
      const one = controls.subscribe(changed), two = queryClient.getQueryCache().subscribe(event => {
        if (event.type === 'updated' && ['success', 'setState'].includes(event.action.type) && event.query.queryKey[0] === 'person-notices' && event.query.queryKey[1] === controls.getState().root) syncSeen();
      }), coalesced = subscribeReads(queryClient, changed), three = useConnection.subscribe(changed);
      return () => { one(); two(); coalesced(); three(); };
    } };
}
