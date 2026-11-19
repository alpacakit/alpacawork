/** Routing reads decision history and complete return causes without loading mutable Task documents. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ControlStore } from '@alpacawork/db';
import { RunStore } from '@alpacawork/runs';
import { MAX_INSTRUCTION_BYTES, questionsOf } from '@alpacawork/raw';
import type { TaskLog } from '@alpacawork/raw';
import type { RunId } from '@alpacawork/contract/fields';
import { storedTaskLogSchema } from '@alpacawork/raw/task-log-schema';
import { readRoutingTasks, TaskRepository } from '@alpacawork/backend/test-dist/control/task-store.js';
import { closureOf, returnFacts, type RunFacts } from '@alpacawork/backend/test-dist/control/return-rules.js';
import { questionApplicable, questionSnapshot } from '@alpacawork/backend/test-dist/control/question-rules.js';
import { ReturnLifecycle } from '@alpacawork/backend/test-dist/control/return-lifecycle.js';
import { returnLines, returnLinesOf } from '@alpacawork/backend/test-dist/control/return-lines.js';
import { FileWriter } from '@alpacawork/backend/test-dist/raw/storage.js';
import { initializeControlFixture, seedFixtureTask } from './helpers/control-fixture.ts';

test('routing facts preserve the first closing result, historical question applicability and delivered return text', t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'routing-task-facts-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const files = new FileWriter(root);
  let project: string;
  try { files.save('config.yaml', null, Buffer.from('agents: {}\n')); project = initializeControlFixture(root); }
  finally { files.close(); }
  const ancestor = seedFixtureTask(root, project, 'Intermediate ancestor');
  const task = seedFixtureTask(root, ancestor.id, 'Routing facts');
  const control = new ControlStore(root), at = Date.now();
  try {
    control.write(db => {
      const uuid = String(db.prepare('SELECT id FROM tasks WHERE external_id=?').get(task.id)!.id);
      const base: TaskLog = { id: 'ordinary', kind: 'reported', at: new Date(at).toISOString(),
        actor: { kind: 'human' }, title: null, description: 'Ordinary comment body', fromState: null, toState: null };
      const entries: TaskLog[] = [base,
        { ...base, id: 'state', toState: 'error' },
        { ...base, id: 'move', kind: 'moved' },
        { ...base, id: 'question', kind: 'asked', actor: { kind: 'placement', placementId: 'synthetic-owner' },
          askedTo: ancestor.id, decide: [{ question: 'Which result?' }] },
        { ...base, id: 'answer', kind: 'answered', questionId: 'question' },
        { ...base, id: 'withdrawal', kind: 'question_withdrawn', questionId: 'question' },
        { ...base, id: 'expiry', kind: 'question_expired', questionId: 'question', closureReason: 'destination_invalid' },
        ...(['archived', 'deleted', 'restored'] as const).map(kind => ({ ...base, id: kind, kind })),
        { ...base, id: 'LSTARTR999', kind: 'linked', description: null },
        { ...base, id: 'LENDR999', kind: 'linked', description: null },
        { ...base, id: 'return-cause', actor: { kind: 'placement', placementId: 'synthetic-owner' },
          title: 'Fixed urgent note', description: 'Keep exact return words.', urgentReason: 'Needs attention' },
      ];
      const first = 2n ** 53n;
      const insert = db.prepare('INSERT INTO task_log(id,task_id,ordinal,entry) VALUES (?,?,?,?)');
      // The closing result follows a complete ordinary-comment page, at ordinals unsafe to round to Number.
      for (let index = 0; index < 128; index++) {
        const entry = { ...base, id: `earlier-comment-${index}` };
        insert.run(entry.id, uuid, first + BigInt(index), JSON.stringify(storedTaskLogSchema.parse(entry)));
      }
      for (const [index, entry] of entries.entries()) insert.run(entry.id, uuid, first + 128n + BigInt(index),
        JSON.stringify(storedTaskLogSchema.parse({ ...entry, at: new Date(at + index * 1000).toISOString() })));
      for (const [id, from, until] of [[ancestor.id, 3250, 3800], [project, 3600, 3900]] as const) {
        const owner = String(db.prepare('SELECT id FROM tasks WHERE external_id=?').get(id)!.id);
        const next = Number(db.prepare('SELECT max(ordinal) AS n FROM task_log WHERE task_id=?').get(owner)!.n) + 1;
        for (const [index, kind, offset] of [[0, 'archived', from], [1, 'restored', until]] as const)
          insert.run(`${id}-${kind}`, owner, next + index, JSON.stringify(storedTaskLogSchema.parse({ ...base,
            id: `${id}-${kind}`, kind, at: new Date(at + offset).toISOString() })));
      }
      db.prepare(`INSERT INTO returns(id,request_id,to_task_id,outcome,boundary_run_id,cause_log_id,created_at)
        VALUES (?,NULL,?,'urgent',NULL,?,?)`).run('synthetic-urgent-return', task.id, 'return-cause', base.at);
    });
    control.write(db => {
      const full = new TaskRepository(root, db).getMany([project, ancestor.id, task.id]);
      const partial = readRoutingTasks(db, [project, ancestor.id, task.id], [task.id], root);
      const request = { id: 'synthetic-request', taskId: task.id, purpose: 'instruction' as const,
        author: { kind: 'human' as const }, submittedAt: new Date(at).toISOString(), deliveryState: 'queued' as const };
      const run: RunFacts = { id: 'R999' as RunId, task: task.id, role: 'owner', requestId: request.id,
        caller: null, state: 'running', reason: null, into: null, stop_requested: false, ended_at: null };
      const facts = (tasks: typeof partial) => returnFacts(tasks.map(item => ({ ...item.meta, responsible: true })), [run]);
      const closed = closureOf(request, facts(partial));
      assert.deepEqual(closed, closureOf(request, facts(full)));
      assert.deepEqual(closed, { outcome: 'failed', runId: null, causeLogId: 'state' },
        'the first failure closes the Request before the later move');
      const applicable = (tasks: typeof partial, when: string) => {
        const own = tasks.find(item => item.id === task.id)!;
        const asked = questionsOf(own.meta.log).find(question => question.asked.id === 'question')!.asked;
        return questionApplicable(task.id, asked, questionSnapshot(tasks), when);
      };
      for (const [offset, expected] of [[3500, true], [3700, false], [3950, true], [4500, false]] as const) {
        const when = new Date(at + offset).toISOString();
        assert.equal(applicable(partial, when), applicable(full, when));
        assert.equal(applicable(partial, when), expected,
          'the containing project can suspend a historical question; an intermediate ancestor does not, and the answer closes it');
      }
      const store = new RunStore(root, { busyTimeoutMs: 1000 }, false, db);
      try {
        store.write(tx => {
          const rows = tx.returns(undefined, [task.id]);
          const text = (tasks: typeof partial) => returnLines(returnLinesOf(new ReturnLifecycle(db, tx, tasks), rows), MAX_INSTRUCTION_BYTES).body;
          assert.equal(text(partial), text(full));
          assert.ok(text(partial).includes('Needs attention'), 'the delivered wake retains the urgent reason');
        });
      } finally { store.close(); }
    });
  } finally { control.close(); }
});
