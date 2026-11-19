import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Problem } from '@alpacawork/core';
import { packagedMigrations } from '@alpacawork/db';
import { RunStore } from '@alpacawork/runs';
import { ReturnLifecycle } from '@alpacawork/backend/test-dist/control/return-lifecycle.js';
import { deliverable } from '@alpacawork/backend/test-dist/control/wake.js';
import { AGENTS_TEMPLATE, parseAgentsSettings, launchSnapshot } from '@alpacawork/backend/test-dist/agents-settings.js';
import { policyBall } from '@alpacawork/contract/task-policy';
import { ballSchema } from '@alpacawork/contract';

test('real admission refusal survives hold, DB read and wake projection without creating Runs', t => {
  const root = mkdtempSync(join(tmpdir(), 'stage3b-hold-')); mkdirSync(join(root, '.alpacawork'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const db = new DatabaseSync(':memory:');
  for (const item of packagedMigrations('control').filter(m => m.name < '20261106020000_agent_settings'))
    db.exec(readFileSync(`packages/db/drizzle/control/${item.name}/migration.sql`, 'utf8'));
  const at = '2026-01-01T00:00:00Z';
  db.prepare(`INSERT INTO tasks(id,kind,number,parent_id,project_task_id,title,lifecycle,base_state,hold,revision,created_at,updated_at)
    VALUES('p','project',1,NULL,NULL,'Synthetic','active','todo',0,1,?,?),('t','task',2,'p','p','Synthetic','active','doing',0,1,?,?)`).run(at, at, at, at);
  db.prepare('INSERT INTO task_log(id,task_id,ordinal,entry) VALUES(?,?,1,?)').run('notice', 't', JSON.stringify({ id: 'notice', kind: 'comment', at, urgentReason: 'synthetic' }));
  db.prepare("INSERT INTO returns(id,to_task_id,outcome,cause_log_id,created_at) VALUES('held','T2','urgent','notice',?)").run(at);
  db.exec(readFileSync('packages/db/drizzle/control/20261106020001_return_hold/migration.sql', 'utf8'));
  const store = new RunStore(root, { busyTimeoutMs: 1000 }, false, db);
  try {
    const config = parseAgentsSettings(AGENTS_TEMPLATE);
    let problem: Problem | undefined;
    try { launchSnapshot(config, 'codex', 'resume', '/bin', {}, { adapter: 'codex', values: { model: 'removed-model' } }); }
    catch (error) { if (error instanceof Problem) problem = error; else throw error; }
    assert.equal(problem?.reason?.kind, 'selection_required');
    store.write(tx => new ReturnLifecycle(db, tx, [{ id: 'T2' }] as any).hold(['held'], problem!.code, problem!.reason));
    config.agents.codex!.params.model!.push('removed-model');
    const row = store.readReturns()[0]!;
    assert.equal(row.holdProblemReason?.kind, 'selection_required');
    const seat = { lifecycle: 'active', state: 'doing', baseState: 'doing', hold: false, head: null,
      profileAvailable: true, automaticLimitReached: false, uncertain: [], openRequests: 0, pending: [row] } as const;
    const block = deliverable(seat, [row]).block;
    assert.ok(block?.human && block.problemReason?.kind === 'selection_required');
    const ball = ballSchema.parse(policyBall({ lifecycle: 'active', state: 'doing', baseState: 'doing', review: null,
      failure: null, openQuestions: [], requester: 'user', requesterAskedUser: false, block, openRequests: 0 }));
    assert.ok(ball.holder === 'user' && ball.problemReason?.kind === 'selection_required');
    assert.equal(ball.problemReason.problems[0]!.previous, 'removed-model');
    assert.equal(ball.problemReason.problems[0]!.candidates.includes('removed-model'), false);
    assert.equal(Number(db.prepare('SELECT count(*) AS count FROM runs').get()!.count), 0);
  } finally { store.close(); db.close(); }
});
