/** Routing prepares outside the writer, then checks the current facts at each seat's write point. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReturnRouter, type RoutingWrite } from '@alpacawork/backend/test-dist/control/return-router.js';
import type { ChangeSeq } from '@alpacawork/db';
import { taskFlow } from './task-flow.fixture.ts';

test('a seat rechecks changed Run facts after preparation and lets reads run before the next seat', async t => {
  const f = await taskFlow(t);
  const first = await f.task('First'), second = await f.task('Second');
  const owner = await f.work(first), child = await f.task('Child', { parentId: first.id });
  const childRun = await f.work(child, owner);
  let writes = 0, readAnswered = false;
  const ordered: RoutingWrite = async execute => {
    if (++writes === 1) {
      // An execution can finish while preparation is outside the lane. The business write must see that finish.
      f.end(childRun, 'failed');
      setImmediate(() => { readAnswered = true; });
    }
    return execute();
  };
  const result = await new ReturnRouter(f.root).route({ tasks: new Set([first.id, second.id]),
    after: 0 as ChangeSeq, through: 1 as ChangeSeq, mode: 'changed' }, undefined, ordered);
  assert.equal(result.completed, true);
  assert.equal(readAnswered, true);
  const returned = f.store(store => store.readReturns().find(row => row.requestId === f.run(childRun).requestId));
  assert.equal(returned?.outcome, 'failed', 'current DB facts decide the closing result');
});
