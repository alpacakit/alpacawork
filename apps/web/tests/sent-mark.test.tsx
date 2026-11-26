/** The arc around a row's state icon lasts from this device's send until the row takes the work up, and goes on every other end. */
import { expect, test } from 'vitest';
import type { CoordinatorConversation } from '../src/data/coordinator';
import type { Outgoing } from '../src/features/coordinator/editor/outbox';
import { localFlag, onItsWay, sentVerdict, tookUp, turnFlag } from '../src/features/coordinator/sent-mark';
import { forgetSent, rememberSent, settleSent, useSentHere, type SentHere } from '../src/features/coordinator/sent-here';
import { served, SERVED } from './conversation-fixture';

const item = (over: Partial<Outgoing> = {}): Outgoing => ({ key: 'k', requestId: 'm0', stage: 'queued', at: '2026-10-29T03:00:00.000Z', refusal: null,
  cancelled: false, taken: false, reader: null, returned: [], last: 'ask', doc: { type: 'doc', content: [] } as never,
  fixed: { conversationId: 'c', text: 'fix it', tasks: ['T4'], attachments: [] }, files: [], ...over });
type Turn = CoordinatorConversation['turns'][number];
const conversation = (turn: Partial<Turn> | null, cancelled: string[] = []) =>
  served({ id: 'c', nextLaunch: { agent: 'claude', values: {} }, ...SERVED, busy: false, cancelled, admitted: {},
    turns: turn ? [{ id: 'm0', at: '2026-10-29T03:00:01.000Z', tasks: ['T4'], status: 'running', result: null, ...turn }] : [] } as CoordinatorConversation);
const PRESS = '2026-10-29T02:00:00.000Z';
const row = (over: { since?: string; status?: string } = {}) => ({
  state: 'waiting' as never,
  stateLog: [{ id: 'l', kind: 'reported', at: over.since ?? PRESS, toState: 'waiting' }] as never,
  rowFacts: { status: over.status ? { kind: over.status } : null, kind: null, childrenRunning: 0, warning: null } as never,
});
const way = (local: Outgoing | null, conv: CoordinatorConversation | null) => onItsWay(localFlag(local), turnFlag(conv, 'm0'));

test('a send is on its way from the press, held on this device, until serve shows its turn', () => {
  expect(way(item(), null)).toBe(true);
  expect(way(item({ stage: 'accepted' }), conversation(null))).toBe(true);
  expect(way(item(), conversation({ status: 'queued' }))).toBe(true);
});

test('a cancelled, refused or taken-back send ends before serve has it', () => {
  for (const over of [{ cancelled: true }, { stage: 'refused' as const }, { taken: true }]) expect(way(item(over), null)).toBe(false);
});

test('an ended turn ends the send even while this device still holds the request as accepted', () => {
  expect(way(item({ stage: 'accepted' }), conversation({ status: 'succeeded' }))).toBe(false);
  expect(way(item({ stage: 'accepted' }), conversation({ status: 'failed' }))).toBe(false);
  expect(way(null, conversation({ status: 'running' }))).toBe(true);
});

test('a joined turn ends when its result arrives, though its status stays joined', () => {
  expect(way(null, conversation({ status: 'joined' }))).toBe(true);
  expect(way(null, conversation({ status: 'joined', result: { writes: [], refused: [] } }))).toBe(false);
});

test('a withdrawn turn, or a request gone from both sides, ends the send', () => {
  expect(way(item(), conversation({ status: 'queued' }, ['m0']))).toBe(false);
  expect(way(null, conversation(null))).toBe(false);
});

const T4 = (over: { since?: string; status?: string } = {}) => ({ id: 'T4', ...row(over) });

test('the latest send on its way gives the baseline; ended sends are to be forgotten', () => {
  const sends: SentHere[] = [{ requestId: 'a', tasks: { T4: 'other' } }, { requestId: 'b', tasks: { T4: PRESS } }];
  expect(sentVerdict(T4(), sends, [true, true])).toEqual({ marked: true, settle: [], ended: [] });
  expect(sentVerdict(T4(), sends, [true, false])).toEqual({ marked: false, settle: ['a'], ended: ['b'] });
  expect(sentVerdict(T4(), sends, [false, false])).toEqual({ marked: false, settle: [], ended: ['a', 'b'] });
});

test('the arc stays while the row is as it was at the press, and goes when a Run is queued or running', () => {
  expect(tookUp(row(), PRESS)).toBe(false);
  expect(tookUp(row({ status: 'still' }), PRESS)).toBe(false);
  expect(tookUp(row({ status: 'queued' }), PRESS)).toBe(true);
  expect(tookUp(row({ status: 'running' }), PRESS)).toBe(true);
});

test('a new state transition ends the arc, whatever either clock says', () => {
  expect(tookUp(row({ since: '2026-10-29T03:00:05.000Z' }), PRESS)).toBe(true);
  expect(tookUp(row({ since: '2026-10-29T01:00:00.000Z' }), PRESS)).toBe(true);
});

test('a row unknown at the press keeps the arc until a Run is queued or running', () => {
  expect(tookUp(row({ since: '2026-10-29T03:00:05.000Z' }), false)).toBe(false);
  expect(tookUp(row({ status: 'queued' }), false)).toBe(true);
});

test('once a row took the work up, its arc never comes back while the turn goes on', () => {
  useSentHere.setState({ sends: [] });
  rememberSent('r1', ['T4', 'T9']);
  const named = () => useSentHere.getState().sends.filter(send => 'T4' in send.tasks);
  const step = (over: { since?: string; status?: string }) => {
    const verdict = sentVerdict(T4(over), named(), named().map(() => true));
    settleSent('T4', verdict.settle); forgetSent(verdict.ended);
    return verdict.marked;
  };
  expect(step({})).toBe(true);
  expect(step({ status: 'queued' })).toBe(false);
  expect(step({ status: 'running' })).toBe(false);
  expect(step({ status: 'still', since: '2026-10-29T03:20:00.000Z' })).toBe(false);
  expect(step({})).toBe(false);
  expect(useSentHere.getState().sends).toEqual([{ requestId: 'r1', tasks: { T9: false } }]);
});

test('rememberSent keeps each named Task, and a resend replaces its own record', () => {
  useSentHere.setState({ sends: [] });
  rememberSent('r1', ['T4', 'T9']);
  rememberSent('r1', ['T4']);
  rememberSent('r2', []);
  expect(useSentHere.getState().sends).toEqual([{ requestId: 'r1', tasks: { T4: false } }]);
});

test('settling and forgetting notify only when a recorded send changes', () => {
  useSentHere.setState({ sends: [] });
  let notifications = 0;
  const unsubscribe = useSentHere.subscribe(() => { notifications++; });
  try {
    const empty = useSentHere.getState();
    settleSent('T4', ['r1']);
    forgetSent(['r1']);
    expect(useSentHere.getState()).toBe(empty);
    expect(notifications).toBe(0);

    const other = { requestId: 'other', tasks: { T4: PRESS } };
    useSentHere.setState({ sends: [other, { requestId: 'r1', tasks: { T4: PRESS, T9: false } }, { requestId: 'r2', tasks: { T4: null } }] });
    notifications = 0;
    const recorded = useSentHere.getState();
    settleSent('T4', ['missing']);
    settleSent('missing', ['r1']);
    forgetSent(['missing']);
    expect(useSentHere.getState()).toBe(recorded);
    expect(notifications).toBe(0);

    settleSent('T4', ['r1', 'r2']);
    expect(useSentHere.getState().sends).toEqual([other, { requestId: 'r1', tasks: { T9: false } }]);
    expect(useSentHere.getState().sends[0]).toBe(other);
    forgetSent(['r1']);
    expect(useSentHere.getState().sends).toEqual([other]);
    expect(notifications).toBe(2);
  } finally {
    unsubscribe();
    useSentHere.setState({ sends: [] });
  }
});
