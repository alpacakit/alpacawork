import { TaskRepository } from '@alpacawork/backend/test-dist/control/task-store.js';
import { dialoguesOf } from '@alpacawork/backend/test-dist/coordinator/messages.js';
/** Loading seeded history must never inherit its provider executable into the synthetic server. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunStore } from '@alpacawork/runs';
import { assertInertFixtureRuns } from '../e2e/fixture/inert-runs.ts';
import { seedHistoryRequest } from '../e2e/fixture/history-request.ts';

test('seeded history retains the focal input and IDs while every synthetic Run uses the inert fixture executable', t => {
  const root=mkdtempSync(join(tmpdir(),'alpacawork-history-fixture-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const seeded=JSON.parse(readFileSync('tests/fixtures/history-request.json','utf8'));
  seedHistoryRequest(root);
  const store=new RunStore(root,{busyTimeoutMs:1000},true);
  try {
    assert.equal(store.getRequest(seeded.request.id)!.body,seeded.body);
    assert.equal(store.getRequest(seeded.request.id)!.headRunId,seeded.log.runId);
    assert.equal(store.getRequest(seeded.request.id)!.aboutRunId,seeded.log.runId);
    assert.equal(store.getRequest(seeded.request.id)!.runId,seeded.request.runId);
    assert.equal(store.getRequest(seeded.request.id)!.purpose,'review_send_back');
    assert.equal(dialoguesOf(store.connection,[new TaskRepository(root, store.connection).metadataWithHistory('T9001')]).filter(row=>row.messageId===seeded.request.id).length,0,
      'a Request author quote is provenance of that one Request, not a second dialogue with its ID');
    for(const run of store.read()) {
      assert.deepEqual(run.launch.argv,['/usr/bin/false'],run.id);
      assert.equal(run.launch.path,'/usr/bin:/bin',run.id);
      assert.throws(() => assertInertFixtureRuns([{ ...run, launch: { ...run.launch, argv: ['seeded-provider'] } }]), /must be inert before serve/);
      assert.throws(() => assertInertFixtureRuns([{ ...run, launch: { ...run.launch, path: '/seeded-provider-path' } }]), /inert fixture path/);
    }
  }finally{store.close();}
});
