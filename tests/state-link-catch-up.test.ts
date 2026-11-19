/**
 * State links that piled up are written one write at a time (ReturnRouter.passProject), so that a request is answered
 * between them: `state-link.test.ts` owns what each boundary does to a Task, this how a pass applies many.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { controlDatabasePath } from '@alpacawork/db';
import { Problem } from '@alpacawork/core';
import { ReturnRouter } from '@alpacawork/backend/test-dist/control/return-router.js';
import { taskFlow, type Seat } from './task-flow.fixture.ts';

/** Runs that started while nothing routed: their starts are pending, none written. */
async function piled(t: Parameters<typeof taskFlow>[0], count: number) {
  const f = await taskFlow(t), seats: Seat[] = [];
  for (let at = 0; at < count; at++) seats.push(await f.request(await f.task(`Work ${at}`)));
  f.store(runs => runs.write(tx => { for (const seat of seats) tx.update({ ...tx.get(seat.runId)!, state: 'running', started_at: new Date().toISOString() }); }));
  const db = new DatabaseSync(controlDatabasePath(f.root), { readOnly: true });
  t.after(() => db.close());
  const written = () => Number((db.prepare("SELECT count(*) AS n FROM task_log WHERE id LIKE 'LSTART%'").get() as { n: number }).n);
  return { f, seats, written };
}

test('links that piled up are written apart, and the thread runs between them', async t => {
  const { f, seats, written } = await piled(t, 6);
  assert.equal(written(), 0);
  // What another request would see at its turns: a pass in one write shows none of them before it has all of them.
  const seen = new Set<number>();
  const looking = setInterval(() => seen.add(written()), 1);
  try { await new ReturnRouter(f.root).pass(undefined, { project: f.project }); }
  finally { clearInterval(looking); }
  assert.equal(written(), seats.length);
  assert.ok(seen.has(1) && seen.has(3) && seen.has(5), `the links in between were seen: ${[...seen]}`);
  for (const seat of seats) assert.equal(await f.state(seat.id), 'doing');
});

test('a waiting write stops preparation before any boundary, and the next pass applies each boundary once', async t => {
  const { f, seats, written } = await piled(t, 5);
  const asked: boolean[] = [];
  await assert.rejects(new ReturnRouter(f.root).pass(resumable => { asked.push(resumable); return resumable; }, { project: f.project }),
    (error: unknown) => error instanceof Problem && error.code === 'busy');
  assert.equal(written(), 0, 'a waiting write takes its turn before boundary preparation');
  assert.equal(asked.at(-1), true);
  await new ReturnRouter(f.root).pass(undefined, { project: f.project });
  assert.equal(written(), seats.length);
  for (const seat of seats) assert.equal((await f.get(seat.id)).meta.log.filter(entry => entry.id === `LSTART${seat.runId}`).length, 1);
});


test('a pass that never yields writes every pending link', async t => {
  const { f, seats, written } = await piled(t, 3);
  await new ReturnRouter(f.root).pass(() => false, { project: f.project });
  assert.equal(written(), seats.length);
  for (const seat of seats) assert.equal(await f.state(seat.id), 'doing');
});
