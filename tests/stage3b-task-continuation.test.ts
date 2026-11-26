import { test } from 'node:test';
import assert from 'node:assert/strict';
import { continuationSessionUnavailable, conversationForRequest } from '../apps/backend/test-dist/control/conversation-context.js';
import { hasContinuableSession } from '../packages/contract/dist/run-contract.js';

test('sessionless finished task Run starts anew by default; explicit continuation remains a continuation', () => {
  for (const state of ['failed', 'cancelled'] as const) {
    const head = { agent: 'codex', state, session: null } as any;
    const facts = { rotation: null, handoff: null, resolvesUnknown: false, agent: 'codex', head, direct: true, resume: 'available' as const };
    assert.equal(hasContinuableSession(head), false);
    assert.equal(continuationSessionUnavailable(head), true);
    assert.equal(conversationForRequest({ ...facts, explicit: undefined }).mode, 'new');
    // History says why: the last conversation could not be resumed; a sender's choice, or another AI, says so instead.
    assert.deepEqual(conversationForRequest({ ...facts, explicit: undefined }).newConversation, { because: 'unresumable' });
    assert.deepEqual(conversationForRequest({ ...facts, explicit: 'new' }).newConversation, { because: 'asked' });
    assert.deepEqual(conversationForRequest({ ...facts, agent: 'claude', explicit: undefined }).newConversation, { because: 'another_ai' });
    assert.equal(conversationForRequest({ ...facts, explicit: 'continue' }).mode, 'continue');
  }
});

test('a task launch that cannot apply its choices needs a new conversation even while the head runs', () => {
  const head = { agent: 'codex', state: 'running', session: { provider: 'codex', id: 'example' } } as any;
  const result = conversationForRequest({ rotation: null, handoff: null, resolvesUnknown: false, agent: 'codex',
    head, direct: true, explicit: undefined, resume: 'choices_unavailable' });
  assert.equal(result.mode, 'new');
  assert.deepEqual(result.newConversation, { because: 'unresumable' });
});
