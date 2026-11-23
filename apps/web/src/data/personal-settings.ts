import { commandRoute } from '@alpacawork/contract/command-path';
import { readQuery, readIndex, subscribeReads, captureReadBoundary, sameReadSession } from './read-model';
import { readWriteBasis } from './connection';
import type { ProjectedIndexDTO } from '@alpacawork/contract/control';
import { useSyncExternalStore } from 'react';
import { createStore } from 'zustand/vanilla';
import { activateLocale, i18n } from '@alpacawork/i18n';
import { isUiLocale } from '@alpacawork/core/ui-language';
import { personalSettingsResponseSchema, type SettingValues } from '@alpacawork/contract';
import { createApi, retryOf } from './client';
import { queryClient } from './query-client';
import { resources, fetchAcceptedResource, acceptPersonalRead, captureResourceRead, admitResourceRead, confirmPersonalRead, readState, sameReadScope, indexKey } from './resources';
import { canSendWrites, useConnection } from './connection';
import { notify, recordFailure } from '@/lib/notify';
import { confirmWriteIntent, conflictWriteIntent, intentKey, intentKeyParts, isLiveWrite, submitWriteIntent, useWriteIntentStore } from './write-intent';

const api = createApi();
async function readSettings(root: string, force = false) {
  const options = resources.personalSettings(root);
  if (force) await queryClient.invalidateQueries({ queryKey: options.queryKey, exact: true, refetchType: 'none' });
  return fetchAcceptedResource(queryClient, options);
}
type Status = 'idle' | 'loading' | 'ready' | 'error';
type PersonState = {
  root: string | null;
  status: Status;
  values: SettingValues;
  revision: string;
  fresh: boolean;
  loadError?: unknown;
  load: (root: string, force?: boolean) => Promise<void>;
  save: (key: string, value: string | boolean | null) => Promise<boolean>;
};
function applyLanguage(values: SettingValues) {
  if (i18n.isInitialized && i18n.language !== values.language && isUiLocale(values.language)) activateLocale(values.language);
}
type PersonControl = Omit<PersonState, 'values' | 'revision' | 'fresh'>;
/** Each setting's last save, whole; a later save of the same setting starts once it has ended. */
const turns = new Map<string, Promise<unknown>>();
/** How long a save that waited for an earlier one waits for the settings to be read again before it is refused. */
const SETTLE_MS = 10_000;
function inTurn(key: string, save: () => Promise<boolean>): Promise<boolean> {
  const earlier = turns.get(key);
  const run = earlier ? waitTurn(earlier, save) : save();
  turns.set(key, run);
  void run.finally(() => { if (turns.get(key) === run) turns.delete(key); }).catch(() => undefined);
  return run;
}
/**
 * A choice made while an earlier save of its setting runs belongs to the read session it was made in (the workspace
 * and read scope then shown). Once its turn comes it is sent only in that same session: a restore, a root change or
 * a cleared and recreated read since (seen at any index change meanwhile) refuses it, so an old screen's choice never
 * becomes a new write in another scope.
 */
async function waitTurn(earlier: Promise<unknown>, save: () => Promise<boolean>): Promise<boolean> {
  const boundary = captureReadBoundary(queryClient);
  let left = !boundary;
  const stop = queryClient.getQueryCache().subscribe((event) => {
    if (event.query.queryKey[0] === 'index' && !sameReadSession(queryClient, boundary)) left = true;
  });
  try {
    await earlier.then(settled, settled);
    if (left || !sameReadSession(queryClient, boundary)) return false;
    return await save();
  } finally { stop(); }
}
/** After an earlier save: until the settings are read again and may be written (refused by the save itself otherwise). */
function settled() {
  const ready = () => { const state = personalSnapshot(); return state.status === 'ready' && state.fresh; };
  if (ready()) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const stop = subscribePersonal(() => { if (ready()) { stop(); clearTimeout(timer); resolve(); } });
    const timer = setTimeout(() => { stop(); resolve(); }, SETTLE_MS);
  });
}
const controls = createStore<PersonControl>((set) => {
  const get = () => personalSnapshot();
  return {
  root: null, status: 'idle',
  load: async (root, force = false) => {
    if (get().root !== root) set({ root, status: 'loading', loadError: undefined });
    else if (get().status !== 'ready') set({ status: 'loading' });
    const source = readIndex(queryClient);
    try {
      await readSettings(root, force);
      const current = get();
      if (current.root !== root || current.status !== 'ready') return;
      // The GET has already published through the common read owner. Apply only
      // that current projection: its own revision change is not a competing save.
      for (const [key, entry] of Object.entries(useWriteIntentStore.getState().entries)) {
        const { root: entryRoot, operation } = intentKeyParts(key);
        if (entryRoot !== root || !operation.startsWith('personal-setting:') || entry.status !== 'unconfirmed') continue;
        const field = operation.slice('personal-setting:'.length);
        const payload = entry.payload as { value: string | boolean; expectedRevision: string };
        if (current.values[field] === payload.value) confirmWriteIntent(key);
        else if (current.revision !== payload.expectedRevision) conflictWriteIntent(key);
      }
      set({ status: 'ready', loadError: undefined });
    } catch (error) {
      if (get().root === root && (!source || sameReadScope(queryClient, source))) set({ status: 'error', loadError: error });
    }
  },
  // One setting's saves run one after another: a later choice waits for an earlier save of it to end, rereads and
  // resends included, and for the settings to be read again, then is compared and sent (or refused) as any save.
  save: (key, value) => inTurn(key, async () => {
    const initial = get();
    if (!initial.root || initial.status !== 'ready' || !initial.fresh) return false;
    const root = initial.root;
    const source = readIndex(queryClient);
    const writeKey = intentKey(root, `personal-setting:${key}`, null);
    if (isLiveWrite(useWriteIntentStore.getState().entries[writeKey]?.status)) return false;
    const previous = initial.values[key];
    if (previous === value) return true;
    const accept = (next: { values: SettingValues; revision: string }, observedRevision: string, started: ReturnType<typeof captureResourceRead>) => {
      const current = get();
      if (current.root !== root || source && !sameReadScope(queryClient, source)) return null;
      if (!admitResourceRead(queryClient, started)) return null;
      // Revisions are opaque. A response started from an older local revision
      // cannot replace a snapshot that another in-flight save has since accepted.
      if (current.revision !== observedRevision) return { values: current.values, revision: current.revision };
      if (!acceptPersonalRead(queryClient, resources.personalSettings(root).queryKey, next, started)) return null;
      return next;
    };
    /** The saved values as read now, once this save's scope still admits them; null when it no longer does. */
    const rereadAccepted = async () => {
      const observedRevision = get().revision;
      const started = captureResourceRead(queryClient, resources.personalSettings(root).queryKey);
      const fetched = await readSettings(root, true);
      confirmPersonalRead(queryClient, resources.personalSettings(root).queryKey, fetched);
      return accept(fetched, observedRevision, started);
    };
    let expectedRevision = initial.revision;
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const started = captureResourceRead(queryClient, resources.personalSettings(root).queryKey);
          const delivery = submitWriteIntent(writeKey, () => ({ key, value, expectedRevision,
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }), input =>
            api.request(commandRoute('settings/set'), personalSettingsResponseSchema, undefined, input, undefined, readWriteBasis(resources.personalSettings(root).queryKey, expectedRevision)), undefined, undefined, { path: 'settings/set', response: 'personal', label: key });
          if (!delivery) return false;
          const next = await delivery;
          const accepted = accept(next, expectedRevision, started);
          if (!accepted) return false;
          return accepted.values[key] === value;
        } catch (error) {
          if (retryOf(error) === 'reread') {
            recordFailure(error, `personal setting ${key}`);
            const latest = await rereadAccepted();
            if (!latest) return false;
            if (latest.values[key] !== previous || attempt === 1) {
              return false;
            }
            expectedRevision = latest.revision;
            continue;
          }
          throw error;
        }
      }
    } catch (error) {
      const unconfirmed = retryOf(error) === 'check';
      // Not known to be saved: the row says it where it is checked (its Reload). Refused or failed: said as the app
      // says any failure, once; the row keeps the last saved value.
      if (unconfirmed) recordFailure(error, `personal setting ${key}`);
      else notify.failure(error, { about: `personal setting ${key}`, text: i18n.t('panels:settings.personal.issue.error') });
      if (unconfirmed) {
        try {
          const latest = await rereadAccepted();
          if (!latest) return false;
          if (latest.values[key] === value) {
            confirmWriteIntent(writeKey);
            return true;
          }
          if (latest.values[key] !== previous) conflictWriteIntent(writeKey);
        } catch { /* Keep the last confirmed value and require an explicit reload. */ }
      }
      return false;
    }
    return false;
  }),
};
});
// A view is derived from the shared Query at notification time. Controls never own a second settings payload.
let previous: { control: PersonControl; queryState: unknown; indexState: unknown; connection: unknown; view: PersonState } | undefined;
function personalSnapshot(): PersonState {
  const control = controls.getState();
  const query = readQuery(queryClient, resources.personalSettings(readIndex(queryClient)?.root ?? control.root ?? '').queryKey);
  const indexState = queryClient.getQueryState(['index']);
  const connection = useConnection.getState();
  if (previous?.control === control && previous.queryState === query?.state && previous.indexState === indexState && previous.connection === connection) return previous.view;
  const read = readState<{ values: SettingValues; revision: string }>(queryClient, query?.queryKey ?? resources.personalSettings(control.root ?? '').queryKey);
  const data = read.data;
  const view: PersonState = { ...control, root: readIndex(queryClient)?.root ?? control.root, values: data?.values ?? EMPTY_VALUES, revision: data?.revision ?? '',
    status: read.status === 'idle' && control.status !== 'ready' ? control.status : read.status, fresh: read.assessment.project && canSendWrites(),
    loadError: query ? query.state.error ?? undefined : control.loadError };
  // Equal fields keep the drawn view: an index publication that changes nothing here redraws nothing.
  const kept = previous && sameFields(previous.view, view) ? previous.view : view;
  previous = { control, queryState: query?.state, indexState, connection, view: kept };
  return kept;
}
const EMPTY_VALUES: SettingValues = {};
const sameFields = (a: object, b: object) => { const x = a as Record<string, unknown>, y = b as Record<string, unknown>, keys = Object.keys(x); return keys.length === Object.keys(y).length && keys.every(key => Object.is(x[key], y[key])); };
const subscribePersonal = (changed: () => void) => {
  const one = controls.subscribe(changed), two = subscribeReads(queryClient, changed), three = useConnection.subscribe(changed);
  return () => { one(); two(); three(); };
};
export function usePersonalSettings<T = PersonState>(selector: (state: PersonState) => T = state => state as unknown as T): T {
  return useSyncExternalStore(subscribePersonal, () => selector(personalSnapshot()));
}
usePersonalSettings.getState = personalSnapshot;
/** Hears every change of the view `getState` derives (its reads, their proofs, the connection), as the hook does. */
usePersonalSettings.subscribe = subscribePersonal;
usePersonalSettings.setState = controls.setState;
usePersonalSettings.getInitialState = controls.getInitialState;

export const visibleSettingValue = (key: string, state: PersonState) => {
  const entry = state.root ? useWriteIntentStore.getState().entries[intentKey(state.root, `personal-setting:${key}`, null)] : undefined;
  return entry?.status === 'pending' ? (entry.payload as { value: string | boolean }).value : state.values[key];
};

// Proof reception and index publication also notify through setState. Apply the
// evaluated value synchronously after either, rather than only a Query success.
queryClient.getQueryCache().subscribe(event => {
  if (event.type !== 'updated' || !['person-settings', 'index'].includes(String(event.query.queryKey[0]))) return;
  const root = readIndex(queryClient)?.root;
  if (!root) return;
  const data = readState<{ values: SettingValues }>(queryClient, resources.personalSettings(root).queryKey).data;
  if (data) applyLanguage(data.values);
});
