import { createHash } from 'node:crypto';
import type { CoordinatorConversation, CoordinatorSnapshot } from '@alpacawork/contract/coordinator';
import { useConversation } from '../src/features/coordinator/coordinator';
import { queryClient } from '../src/data/query-client';
import { readIndex, readQuery, captureReadProof, recordReadProof, recordIndexProof } from '../src/data/read-model';
import { receiveFullIndex } from '../src/data/resources';
import { indexOf, tree } from './fixtures';
import { useConnection } from '../src/data/connection';
import type { ProjectedIndexDTO } from '@alpacawork/contract/control';

/** Fixtures use the new wire DTO; production accepts no old conversation response. */
export function conversationSnapshot(conversation: CoordinatorConversation): CoordinatorSnapshot {
  conversation = JSON.parse(JSON.stringify(Object.assign({ busy: false }, conversation)));
  const index = readIndex(queryClient);
  return { root: index?.root ?? '/fixture', generation: index?.generation ?? 'a',
    revision: createHash('sha256').update(JSON.stringify(conversation)).digest('hex'), conversation };
}
export const conversationRevision = (seed: string) => createHash('sha256').update(seed).digest('hex');
export function snapshotJson(value: unknown) {
  return JSON.stringify(value && typeof value === 'object' && 'turns' in value && 'id' in value
    ? conversationSnapshot(value as CoordinatorConversation) : value);
}
/** Test arrangement goes into the sole Query, never an alternative product setter. */
export function setConversationState(input: Partial<ReturnType<typeof useConversation.getState>>) {
  const { conversation, read: _read, trying: _trying, ...ui } = input;
  if (input === useConversation.getInitialState()) queryClient.removeQueries({ queryKey: ['coordinator'] });
  let index = readIndex(queryClient);
  if (conversation && !index || index && ui.root && ui.root !== index.root) {
    const first = !index;
    index = index ? { ...index, root: ui.root! } : indexOf(tree({ root: ui.root || '/fixture' }));
    receiveFullIndex(queryClient, index);
    if (first) useConnection.setState({ state: 'live', offline: false });
  }
  useConversation.setState(ui);
  if (conversation === null) queryClient.removeQueries({ queryKey: ['coordinator'] });
  else if (conversation) {
    const snapshot = conversationSnapshot(conversation);
    if (!index) throw new Error('Conversation fixture needs its served index');
    const next = { ...index, person: { ...index.person, coordinator: { id: conversation.id, revision: snapshot.revision } } };
    queryClient.setQueryData(['index'], next); recordIndexProof(queryClient, next);
    const key = ['coordinator', next.root]; queryClient.setQueryData(key, snapshot);
    recordReadProof(readQuery(queryClient, key)!, captureReadProof(next, key));
    useConversation.setState({ seen: new Set(conversation.turns.filter(turn => turn.seen).map(turn => turn.id)) });
  }
}

/** Announce real index evidence, rather than inventing a version outside the read Owner. */
export function announceConversation(seed: string) {
  const index = readIndex(queryClient); if (!index) throw new Error('Announcement needs an index');
  const id = index.person.coordinator?.id ?? useConversation.getState().conversation?.id ?? 'conversation-1';
  receiveFullIndex(queryClient, { ...index, rev: index.rev + 1, person: { ...index.person, coordinator: { id, revision: conversationRevision(seed) } } });
  useConversation.getState().follow();
}

/** Initial live fixture read reaches the same fetch/reception/projection as the product. No conversation Query injection. */
export async function readConversationThroughOwner(conversation: CoordinatorConversation, root = '/fixture', servedIndex?: ProjectedIndexDTO) {
  const held = readIndex(queryClient);
  const index = servedIndex ?? (held?.root === root ? held : indexOf(tree({ root })));
  receiveFullIndex(queryClient, index);
  const snapshot = conversationSnapshot(conversation);
  // A boundary test can announce independent server evidence; never repair it from the response under test.
  if (!servedIndex) receiveFullIndex(queryClient, { ...index, person: { ...index.person, coordinator: { id: conversation.id, revision: snapshot.revision } } });
  useConnection.setState({ state: 'live', fresh: true, writable: index.writable, offline: false });
  useConversation.setState({ root });
  await useConversation.getState().refresh();
}
