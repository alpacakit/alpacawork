/** Serialized reads through the one retention policy, as the policy's own tests drive it. */
import { hashKey, type DehydratedState } from '@tanstack/react-query';
import type { ProjectedIndexDTO } from '@alpacawork/contract/control';
import { requiredReadKeys } from '../src/data/read-model';
import { readDataSize, selectGroups } from '../src/data/read-retention';

type Read = DehydratedState['queries'][number];
const diskBytes = (read: Read) => readDataSize(read.state.data, data => ({ ...read, state: { ...read.state, data } }));
export function selectRetainedReads(reads: Read[], now: number, envelopeBytes: number, active: ReadonlySet<string> = new Set()) {
  const index = reads.find(read => read.queryKey[0] === 'index')?.state.data as ProjectedIndexDTO | undefined;
  const required = new Set(index ? requiredReadKeys(index).map(hashKey) : []);
  const present = new Set(reads.map(read => read.queryHash));
  const absent = index ? [...required].filter(key => !present.has(key)) : [hashKey(['index'])];
  const selection = selectGroups(reads.map(read => ({ value: read, key: read.queryKey, hash: read.queryHash, data: read.state.data,
    usedAt: Number(read.meta?.readUsedAt ?? read.state.dataUpdatedAt), bytes: diskBytes(read), required: required.has(read.queryHash), protected: active.has(read.queryHash) })), now, envelopeBytes, true);
  const { selected: _selected, ...result } = selection;
  return { ...result, absent, queries: index ? selection.selected.map(item => item.value) : [] };
}
