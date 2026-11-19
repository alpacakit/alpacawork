/** Saved automatic-return refusals keep the facts that made the admission fail. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeControlFixture, seedFixtureTask } from './helpers/control-fixture.ts';
import { RunStore, returnHold, parseReturnHold } from '@alpacawork/runs';

test('structured selection refusal survives persistence, duplicate holds and clearing', t => {
  const root=mkdtempSync(join(tmpdir(),'return-hold-storage-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const project=initializeControlFixture(root), task=seedFixtureTask(root,project,'Synthetic');
  const store=new RunStore(root,{busyTimeoutMs:1000}), db=store.connection;
  try {
    const reason={kind:'selection_required' as const,problems:[{key:'effort',previous:null,candidates:['high',null],reason:'null_required' as const,recovery:'select_value' as const}]};
    const saved=JSON.stringify(returnHold('invalid_input',reason));
    const notice=db.prepare('SELECT l.id FROM task_log l JOIN tasks t ON t.id=l.task_id WHERE t.external_id=? ORDER BY ordinal LIMIT 1').get(task.id)!;
    db.prepare("INSERT INTO returns(id,to_task_id,outcome,cause_log_id,hold_reason,created_at) VALUES('held',?,'work_changed',?,?,?)")
      .run(task.id,String(notice.id),saved,'2026-01-01T00:00:00Z');
    reason.problems[0]!.candidates.splice(0,1,'changed later');
    assert.deepEqual(store.readReturns()[0]!.holdProblemReason,{kind:'selection_required',problems:[{key:'effort',previous:null,candidates:['high',null],reason:'null_required',recovery:'select_value'}]});
    assert.equal(db.prepare('UPDATE returns SET hold_reason=? WHERE id=? AND hold_reason IS NOT ?').run(saved,'held',saved).changes,0);
    assert.throws(()=>db.prepare("UPDATE returns SET hold_reason='too_deep'").run(),/invalid return hold/);
    db.prepare('UPDATE returns SET hold_reason=NULL WHERE id=?').run('held');
    assert.deepEqual([store.readReturns()[0]!.holdReason,store.readReturns()[0]!.holdProblemReason],[null,null]);
  } finally {store.close();}
});

test('current hold decoder refuses legacy or invalid reasons instead of filling current facts',()=>{
  assert.throws(()=>parseReturnHold('too_deep'));
  assert.throws(()=>parseReturnHold(JSON.stringify({code:'invalid_input',reason:{kind:'selection_required',problems:[]}})));
  assert.throws(()=>parseReturnHold(JSON.stringify({code:'invalid_input',reason:null,extra:true})));
});
