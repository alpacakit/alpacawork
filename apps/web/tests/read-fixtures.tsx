/** Controlled server receipts for component tests. Production tests use actual GETs instead. */
import { queryClient } from '../src/data/query-client';
import { usePersonalSettings } from '../src/data/personal-settings';
import { useReadStore } from '../src/state/read-store';
import { receiveFullIndex, resources } from '../src/data/resources';
import { captureReadProof, recordReadProof } from '../src/data/read-model';
import { useConnection } from '../src/data/connection';
import { NOTICE_VERSION } from '../src/data/notice-model';
import { dto, indexOf, tree, viewsOf } from './fixtures';
import type { SettingValues } from '@alpacawork/contract';
import type { ProjectedIndexDTO } from '@alpacawork/contract/control';
export function fixtureReceipt<T = unknown>(key: readonly unknown[], data: any) {
  queryClient.setQueryData(key, data);
  const index = queryClient.getQueryData<ProjectedIndexDTO>(['index']), query = queryClient.getQueryCache().find({ queryKey: key, exact: true });
  if (index && query) recordReadProof(query, captureReadProof(index, key));
  return query?.state.data as T | undefined;
}
function current(root: string, person?: Partial<ProjectedIndexDTO['person']>) {
  const held = queryClient.getQueryData<ProjectedIndexDTO>(['index']);
  const index = held?.root === root ? held : indexOf(tree({ root }));
  receiveFullIndex(queryClient, { ...index, person: { ...index.person, ...person } });
  useConnection.setState({ state: 'live', fresh: true, writable: true, offline: false });
}
export function seedPersonal(values: { root?: string | null; values: SettingValues; revision?: string; status?: 'ready'; fresh?: boolean }) {
  const root = values.root ?? usePersonalSettings.getState().root ?? '/fixture', revision = values.revision ?? 'r1';
  current(root, { settings: revision });
  fixtureReceipt(resources.personalSettings(root).queryKey, { values: values.values, revision });
  usePersonalSettings.setState({ root, status: values.status ?? 'ready' });
}
type NoticeView = ReturnType<typeof useReadStore.getState>;
type NoticeTarget = { getState: () => NoticeView; setState: typeof useReadStore.setState };
export function seedNotices(target: NoticeTarget, values: Partial<NoticeView>) {
  const root = values.root ?? target.getState().root ?? '/fixture', revision = values.revision ?? target.getState().revision ?? 'fixture-notices-1';
  current(root, { notices: revision });
  const prior = target.getState();
  fixtureReceipt(resources.notices(root).queryKey, { state: { version: NOTICE_VERSION,
    checkpoint: values.checkpoint ?? prior.checkpoint ?? { at: new Date().toISOString(), tasks: {} }, reads: values.reads ?? prior.reads }, revision });
  const { checkpoint: _checkpoint, reads: _reads, revision: _revision, fresh: _fresh, ...control } = values;
  target.setState({ ...control, root, serverRevision: values.serverRevision ?? revision });
}

export function allowFixtureWrites() { const value = tree({ tasks: [dto({ id: 'T1' }), dto({ id: 'T2' })] }); receiveFullIndex(queryClient, indexOf(value)); for (const view of viewsOf(value)) fixtureReceipt(resources.taskView(value.root, view.task.id).queryKey, view); useConnection.setState({ state: 'live', fresh: true, writable: true, offline: false }); }
