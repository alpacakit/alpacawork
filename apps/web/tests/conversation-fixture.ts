import { createHash } from 'node:crypto';
import type { CoordinatorConversation, CoordinatorMessageStatus, CoordinatorSnapshot } from '../src/data/coordinator';
import { useConversation } from '../src/features/coordinator/coordinator';
import { queryClient } from '../src/data/query-client';
import { readIndex, readQuery, captureReadProof, recordReadProof, recordIndexProof } from '../src/data/read-model';
import { receiveFullIndex } from '../src/data/resources';
import { indexOf, tree } from './fixtures';
import { useConnection } from '../src/data/connection';
import type { ProjectedIndexDTO } from '@alpacawork/contract/control';
import { coordinatorMessageDigest } from '@alpacawork/contract/coordinator';

/** What every served conversation carries besides its turns: nothing older, no reset, no usage yet, the default reset. */
export const SERVED: Pick<CoordinatorConversation, 'earlier' | 'resets' | 'context' | 'autoReset'> = { earlier: null, resets: [], context: null, autoReset: { tokens: 200000, percent: 50 } };
type Turn = CoordinatorConversation['turns'][number];
/** A turn as a test writes it: serve's receipt is optional and, left out, is the one serve computes for its input. */
export type FixtureTurn = Omit<Turn, 'inputDigest'> & { inputDigest?: string };
/** A conversation as a test writes it: the page's withdrawals (`cancelled`) are optional and never served. */
export type FixtureConversation = Omit<CoordinatorConversation, 'cancelled' | 'admitted' | 'turns'> & { turns: FixtureTurn[];
  cancelled?: readonly string[]; admitted?: CoordinatorConversation['admitted'] };
/** The conversation as serve holds it: each turn with its receipt, as the page holds it (no learnt withdrawals). */
export const served = <T extends FixtureConversation>(fixture: T): T & Pick<CoordinatorConversation, 'turns' | 'cancelled' | 'admitted'> =>
  ({ cancelled: [], admitted: {}, ...fixture, turns: fixture.turns.map(turn => servedTurn(fixture.id, turn)) });
/** One turn of conversation `conversationId` as serve holds it: with the receipt of its input, unless the test gave one. */
export const servedTurn = (conversationId: string, turn: FixtureTurn): Turn => ({ ...turn, inputDigest: turn.inputDigest ?? turnDigest(conversationId, turn) });
/** Fixtures use the new wire DTO; production accepts no old conversation response. */
export function conversationSnapshot(fixture: FixtureConversation): CoordinatorSnapshot {
  const { cancelled: _cancelled, admitted: _admitted, ...held } = served(fixture);
  const conversation = JSON.parse(JSON.stringify(Object.assign({ busy: false }, held)));
  const index = readIndex(queryClient);
  return { root: index?.root ?? '/fixture', generation: index?.generation ?? 'a',
    revision: createHash('sha256').update(JSON.stringify(conversation)).digest('hex'), conversation };
}
export const conversationRevision = (seed: string) => createHash('sha256').update(seed).digest('hex');
export function snapshotJson(value: unknown) {
  return JSON.stringify(value && typeof value === 'object' && 'turns' in value && 'id' in value
    ? conversationSnapshot(value as FixtureConversation) : value);
}
/**
 * What serve says of one message in a fixture: `cancelled` stands for the withdrawals serve knows of (a snapshot names
 * none, only a message's own status does), else its turn's status, else missing.
 */
type StatusName = CoordinatorMessageStatus['status'];
/** The digest serve keeps of a turn's input: the same contract function the outbox checks against. */
export const turnDigest = (conversationId: string, turn: FixtureTurn) => coordinatorMessageDigest({
  conversationId, id: turn.id, text: turn.ask, replyTo: turn.replyTo?.id ?? null, tasks: turn.tasks, skills: turn.skills,
  attachments: turn.attachments, intent: turn.intent, answers: turn.answers });
/** A digest of no input this page sent (a status named without its turn). */
const OTHER_INPUT = '0'.repeat(64);
/**
 * Where one message is, as serve says it: withdrawn or missing, or its status with the digest of the input it took
 * (`status` names one other than the conversation's own).
 */
export function messageStatus(fixture: FixtureConversation, id: string, status?: StatusName): CoordinatorMessageStatus {
  const turn = fixture.turns.find(each => each.id === id);
  const name = status ?? (fixture.cancelled?.includes(id) ? 'withdrawn' : turn?.status ?? 'missing');
  if (name === 'withdrawn' || name === 'missing') return { id, status: name };
  return { id, status: name, inputDigest: turn ? turnDigest(fixture.id, turn) : OTHER_INPUT };
}
/** A send's, a withdrawal's or a send-now's answer: the snapshot and where that message is now. */
export function messageJson(fixture: FixtureConversation, id: string, status?: StatusName) {
  return JSON.stringify({ ...conversationSnapshot(fixture), message: messageStatus(fixture, id, status) });
}
/** The answer of GET /api/coordinator/messages/:id/status: a status, or one named alone (taken with another input). */
export const statusJson = (id: string, status: StatusName | CoordinatorMessageStatus) =>
  JSON.stringify(typeof status === 'object' ? status : status === 'withdrawn' || status === 'missing' ? { id, status } : { id, status, inputDigest: OTHER_INPUT });
const statusUrl = /^\/api\/coordinator\/messages\/([^/]+)\/status$/;
const messageUrl = /^\/api\/coordinator\/messages(\/withdraw|\/send-now)?$/;
/**
 * Serve's answer to one coordinator request, given the conversation it holds: a message's status, a message request's
 * snapshot with that message, or the snapshot.
 */
export function servedJson(url: string, init: RequestInit | undefined, fixture: FixtureConversation) {
  const status = statusUrl.exec(url);
  if (status) { const id = decodeURIComponent(status[1]!); return statusJson(id, messageStatus(fixture, id)); }
  if (messageUrl.test(url) && typeof init?.body === 'string') return messageJson(fixture, (JSON.parse(init.body) as { id: string }).id);
  return snapshotJson(fixture);
}
/** A fetch that answers every coordinator request as serve holding this conversation would. */
export const serving = (fixture: FixtureConversation) => (url: string, init?: RequestInit) => Promise.resolve(new Response(servedJson(url, init, fixture)));
/** Test arrangement goes into the sole Query, never an alternative product setter. */
export function setConversationState(input: Omit<Partial<ReturnType<typeof useConversation.getState>>, 'conversation'> & { conversation?: FixtureConversation | null }) {
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
  // Withdrawals the page learnt belong to the conversation the test ends with.
  if (conversation === null) { queryClient.removeQueries({ queryKey: ['coordinator'] }); queryClient.removeQueries({ queryKey: ['coordinator-history'] }); useConversation.setState({ learnt: null }); }
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
export async function readConversationThroughOwner(conversation: FixtureConversation, root = '/fixture', servedIndex?: ProjectedIndexDTO) {
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
