import { dehydrate, hashKey, QueryClient, type DehydratedState } from '@tanstack/react-query';
import { READ_MAX_BYTES, READ_TASK_AGE } from '../src/data/read-model';
import { Buffer } from 'node:buffer';
import { dto, indexOf, tree } from './fixtures';

type Read = DehydratedState['queries'][number];
export const ORACLE_NOW = 1_792_540_800_000;
export function retentionCase(name: string) {
  const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
  const index = indexOf(tree({ tasks: [dto()] }));
  client.setQueryData(['index'], index);
  client.setQueryData(['person-settings', index.root], { values: {}, revision: index.person.settings });
  client.setQueryData(['person-notices', index.root], { state: null, revision: index.person.notices });
  const reads: Read[] = dehydrate(client).queries.map(read => ({ ...read, dehydratedAt: ORACLE_NOW,
    state: { ...read.state, dataUpdatedAt: ORACLE_NOW }, meta: { readUsedAt: ORACLE_NOW } }));
  client.clear();
  const record = (queries: Read[]) => ({ token: '0'.repeat(36), bundle: { format: 5, origin: 'http://localhost',
    root: index.root, generation: index.generation, rev: index.rev, savedAt: ORACLE_NOW, receivedAt: ORACLE_NOW,
    snapshot: { mutations: [], queries } } });
  const active = new Set<string>();
  const add = (id: string, body = '', usedAt = ORACLE_NOW, kind = 'task') => {
    const queryKey = [kind, index.root, id];
    const read: Read = { ...reads[0]!, queryKey, queryHash: hashKey(queryKey),
      meta: { readUsedAt: usedAt }, state: { ...reads[0]!.state, data: { task: { id, body } } } };
    reads.push(read); return read;
  };
  if (name === 'empty-input') reads.length = 0;
  else if (name === 'required-missing') reads.splice(reads.findIndex(r => r.queryKey[0] === 'person-notices'), 1);
  else if (name === 'required-oversized') (reads[0]!.state.data as any).errors = [{ message: 'x'.repeat(READ_MAX_BYTES) }];
  else if (name.startsWith('bytes-')) {
    const delta = Number(name.slice(6)), read = add('T1');
    const padding = READ_MAX_BYTES + delta - Buffer.byteLength(JSON.stringify(record(reads)), 'utf8');
    (read.state.data as any).task.body = 'x'.repeat(padding);
  } else if (name.startsWith('count-')) {
    for (let n = 1; n <= Number(name.slice(6)); n++) { add('T' + n, '', ORACLE_NOW + n); add('T' + n, '', ORACLE_NOW + n, 'task-history'); }
  } else if (name === 'required-only') { /* empty optional array */ }
  else if (name === 'unicode-escape-empty') {
    add('T1', '日本語🍵\n\r\t"\\\u0000\ud800'); add('T2', '');
  } else if (name === 'active-byte-overflow') { active.add(add('T1', 'x'.repeat(READ_MAX_BYTES)).queryHash); add('T2', 'fits'); }
  else if (name === 'active-task-overflow') {
    for (let n = 1; n <= 101; n++) active.add(add('T' + n, '', ORACLE_NOW + n).queryHash);
  } else if (name === 'active-expired') active.add(add('T1', '', ORACLE_NOW - READ_TASK_AGE).queryHash);
  else if (name === 'deadline-before') add('T1', '', ORACLE_NOW - READ_TASK_AGE + 1);
  else if (name === 'deadline-exact') add('T1', '', ORACLE_NOW - READ_TASK_AGE);
  else if (name === 'deadline-after') add('T1', '', ORACLE_NOW - READ_TASK_AGE - 1);
  else if (name === 'group-latest-deadline') { add('T1', '', ORACLE_NOW - READ_TASK_AGE); add('T1', '', ORACLE_NOW - READ_TASK_AGE + 10, 'task-history'); }
  else if (name === 'page-overlap-100') {
    for (let n = 1; n <= 99; n++) add('T' + n);
    const page = add('root', '', ORACLE_NOW + 1, 'task-finished');
    page.queryKey = ['task-finished', index.root, 'root', null]; page.queryHash = hashKey(page.queryKey);
    page.state.data = { pages: [{ rows: [{ id: 'T99' }, { id: 'T100' }] }], pageParams: [null] };
  } else if (name === 'search-deadline') {
    const read = add('find', '', ORACLE_NOW - 60_000, 'task-search');
    read.state.data = { pages: [{ rows: [] }], pageParams: [null] };
  } else throw new Error('Unknown retention case: ' + name);
  return { reads, now: ORACLE_NOW, record, active };
}
export const RETENTION_CASES = ['empty-input', 'required-only', 'unicode-escape-empty', 'bytes--1', 'bytes-0', 'bytes-1',
  'count-99', 'count-100', 'count-101', 'required-missing', 'required-oversized', 'active-byte-overflow', 'active-task-overflow',
  'active-expired', 'deadline-before', 'deadline-exact', 'deadline-after', 'group-latest-deadline', 'page-overlap-100', 'search-deadline'];
