/** Current command publication and indexed question lookup. No historical database is loaded. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { attemptOf, enqueueCommand, publishCommands } from '@alpacawork/backend/test-dist/runs/execution-control.js';
import { executionFolder, publishCommand } from '@alpacawork/backend/test-dist/runs/execution-files.js';
import { settleTransaction, closeLaunches } from '@alpacawork/backend/test-dist/runs/scheduler.js';
import { readAgentsSettings } from '@alpacawork/backend/test-dist/agents-settings.js';
import { readTaskView } from '@alpacawork/backend/test-dist/control/task-views.js';
import { setup } from './runs-runtime.fixture.ts';
import { taskFlow } from './task-flow.fixture.ts';

test('column commands preserve wire bytes, stop priority and resend after publication before DB acknowledgement', async t => {
  const f = await setup(t), run = f.create(); f.pauseProjection();
  const decision = await settleTransaction(f.store, readAgentsSettings(f.root)); closeLaunches(decision.launches);
  const launch = attemptOf(f.store, run.id)!, inputId = randomUUID();
  const commands = f.store.write(() => [
    enqueueCommand(f.store, launch, { type: 'input', inputId, instructionRunId: run.id, text: 'Synthetic input 💡\nwith a NUL: \0' }),
    enqueueCommand(f.store, launch, { type: 'cancel-input', inputId, instructionRunId: run.id }),
    enqueueCommand(f.store, launch, { type: 'stop' }),
  ]);
  const h = { f, launch, commands, rows: () => f.store.connection.prepare('SELECT type,published FROM run_commands ORDER BY seq').all() };
  const folder = join(executionFolder(h.f.root, h.launch.runId, h.launch.attemptId), 'commands');
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, '000000000001.json'), '{}');
  assert.throws(() => publishCommands(f.store), /conflict/i);
  assert.deepEqual(h.rows().map(row => [row.type, row.published]), [['input', 0], ['cancel-input', 1], ['stop', 1]],
    'stop and cancellation publish before the conflicting earlier input');
  rmSync(join(folder, '000000000001.json'));
  publishCommand(h.f.root, h.commands[0]!); // Model death after file fsync but before published=1 commits.
  publishCommands(f.store);
  for (const command of h.commands)
    assert.deepEqual(JSON.parse(readFileSync(join(folder, String(command.seq).padStart(12, '0') + '.json'), 'utf8')), command);
  assert.ok(h.rows().every(row => row.published === 1));
});

test('question lookup uses a question-only access path and keeps incoming questions and answers through an intermediate Task', async t => {
  const f = await taskFlow(t), top = await f.task('Top'), parent = await f.work(top);
  const child = await f.task('Middle', { parentId: top.id }), owner = await f.work(child, parent);
  const leaf = await f.task('Leaf', { parentId: child.id }), worker = await f.work(leaf, owner);
  const question = await f.ask(worker, top.id);
  const plans: string[] = [], prepare = DatabaseSync.prototype.prepare;
  const hook = t.mock.method(DatabaseSync.prototype, 'prepare', function(this: DatabaseSync, sql: string) {
    const db = this;
    const statement = prepare.call(this, sql);
    if (sql.trimStart().startsWith('WITH RECURSIVE below')) {
      const all = statement.all;
      statement.all = function(...args: Parameters<typeof all>) {
        plans.push(...prepare.call(db, 'EXPLAIN QUERY PLAN ' + sql).all(...args).map(row => String(row.detail)));
        return all.apply(this, args);
      };
    }
    return statement;
  });
  try {
    const incoming = await readTaskView(f.root, top.id, {}, null);
    assert.deepEqual(incoming.incomingQuestions.map(item => item.id), [question]);
    assert.deepEqual((await readTaskView(f.root, child.id, {}, null)).incomingQuestions, []);
    await f.answer(leaf.id, question, parent);
    assert.ok((await readTaskView(f.root, child.id, {}, null)).relevantAnswers.some(item => item.id === question));
  } finally { hook.mock.restore(); }
  assert.ok(plans.some(detail => /(?:SCAN|SEARCH) l\b/.test(detail)), 'observed the real question lookup');
  assert.ok(!plans.some(detail => detail === 'SCAN l'), 'a query of questions must not scan every history row');
});
