import { test } from 'node:test';
import assert from 'node:assert/strict';
import { continuationSessionUnavailable, conversationForRequest } from '../apps/backend/test-dist/control/conversation-context.js';
import { hasContinuableSession } from '../packages/contract/dist/run-contract.js';

test('sessionless finished task Run starts anew by default; explicit continuation remains a continuation', () => {
  for (const state of ['failed', 'cancelled'] as const) {
    const head = { state, session: null } as any;
    const facts = { rotation: null, handoff: null, resolvesUnknown: false, anotherAi: false, head, direct: true, resumable: true };
    assert.equal(hasContinuableSession(head), false);
    assert.equal(continuationSessionUnavailable(head), true);
    assert.equal(conversationForRequest({ ...facts, explicit: undefined }).mode, 'new');
    // History says why: the last conversation could not be resumed; a sender's choice, or another AI, says so instead.
    assert.deepEqual(conversationForRequest({ ...facts, explicit: undefined }).newConversation, { because: 'unresumable' });
    assert.deepEqual(conversationForRequest({ ...facts, explicit: 'new' }).newConversation, { because: 'asked' });
    assert.deepEqual(conversationForRequest({ ...facts, anotherAi: true, explicit: undefined }).newConversation, { because: 'another_ai' });
    assert.equal(conversationForRequest({ ...facts, explicit: 'continue' }).mode, 'continue');
  }
});
