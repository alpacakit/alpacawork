import { test } from 'node:test';
import assert from 'node:assert/strict';
import { operationReadActions, localCaller, replyAccess, reportCallerRules, urgentRecipient } from '@alpacawork/contract/access-boundaries';
import { localStopCaller, stopLocal } from '@alpacawork/contract/local-stop';

test('report handoffs and recipient selection stay limited to their Run report forms', () => {
  const run = { kind: 'run', taskId: 'T1' }, human = { kind: 'human' };
  assert.equal(reportCallerRules.checkpoint.allows({}, human), true);
  for (const input of [{ values: {} }, { nextConversation: 'new' }]) {
    assert.equal(reportCallerRules.checkpoint.allows(input, run), true);
    assert.equal(reportCallerRules.checkpoint.allows(input, human), false);
    assert.equal(reportCallerRules.checkpoint.allows({ ...input, aboutRun: 'R1' }, run), false);
  }
  assert.equal(reportCallerRules.askTo.allows({ state: 'waiting' }, human), true);
  assert.equal(reportCallerRules.askTo.allows({ state: 'waiting', askTo: 'user' }, run), true);
  assert.equal(reportCallerRules.askTo.allows({ state: 'waiting', askTo: 'user' }, human), false);
  assert.equal(reportCallerRules.askTo.allows({ state: 'done', askTo: 'user' }, run), false);
  assert.equal(reportCallerRules.askTo.allows({ task: 'T2', state: 'waiting', askTo: 'user' }, run), false);
  assert.equal(reportCallerRules.checkpoint.allows({ task: 'T2', values: { notes: 'Child notes' } }, run), false);
});

test('reply access requires a screen Run and actual delivery evidence, without loading evidence for other callers', () => {
  const notRead = () => { throw new Error('unauthorized speaker read delivery evidence'); };
  assert.equal(replyAccess.allows({ source: 'codex', runId: 'R1' }, notRead), false);
  assert.equal(replyAccess.allows({ source: 'screen' }, notRead), false);
  const read: string[] = [];
  assert.equal(replyAccess.allows({ source: 'screen', runId: 'R2' }, id => { read.push(id); return false; }), false);
  assert.equal(replyAccess.allows({ source: 'screen', runId: 'R3' }, id => { read.push(id); return true; }), true);
  assert.deepEqual(read, ['R2', 'R3']);
});

test('operation receipts authorize every distinct Task, or screen access when no Task is referenced', () => {
  assert.deepEqual(operationReadActions([]), [{ action: { name: 'screen' }, task: null }]);
  assert.deepEqual(operationReadActions(['T3', 'T1', 'T3']), [
    { action: { name: 'task.read' }, task: 'T3' }, { action: { name: 'task.read' }, task: 'T1' },
  ]);
});

test('urgent delivery requires a Task requester', () => {
  assert.equal(urgentRecipient.allows(null), false);
  assert.equal(urgentRecipient.allows('T2'), true);
});

test('either Run credential refuses local stop before any workspace access', () => {
  assert.equal(localStopCaller.allows({}), true);
  assert.equal(localStopCaller.allows({ ALPACAWORK_RUN: '', ALPACAWORK_RUN_TOKEN: '' }), true);
  for (const env of [{ ALPACAWORK_RUN: 'R1' }, { ALPACAWORK_RUN_TOKEN: 'token' }]) {
    assert.equal(localStopCaller.allows(env), false);
    assert.throws(() => stopLocal('/does-not-exist', 'R1', 'operation', env),
      /stop-local requires a local human outside a Run/);
  }
});


test('local administration claims Run identity by key presence, even for empty credentials', () => {
  assert.equal(localCaller.claimsRun({}), false);
  assert.equal(localCaller.claimsRun({ ALPACAWORK_RUN: '' }), true);
  assert.equal(localCaller.claimsRun({ ALPACAWORK_RUN_TOKEN: undefined }), true);
});
