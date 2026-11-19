/** Real accepted Request -> ancestor move -> scheduler -> Return owner, shared by HTTP and browser regressions. */
import assert from 'node:assert/strict';
import { constants, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { taskFlow } from './task-flow.fixture.ts';
import { decide } from '@alpacawork/backend/test-dist/runs/scheduler.js';
import { readAgentsSettings } from '@alpacawork/backend/test-dist/agents-settings.js';
import { ReturnRouter } from '@alpacawork/backend/test-dist/control/return-router.js';
import { tryLock, unlock } from '@alpacawork/core';
import { RUN_FILES } from '@alpacawork/contract/run';

export async function invalidationHistory(t: { after(cleanup: () => void): unknown }) {
  const f = await taskFlow(t), a = await f.task('Original parent A'), b = await f.task('New parent B');
  const x = await f.task('Moved ancestor X', { parentId: a.id }), owner = await f.work(x);
  const y = await f.task('Accepted child Y', { parentId: x.id }), child = await f.request(y, owner);
  f.end(owner);
  await f.commands.move({ id: x.id, parentId: b.id, expectedTaskHash: (await f.get(x.id)).hash });
  f.store(store => store.write(tx => decide(tx, { store, settings: readAgentsSettings(f.root), releaseLocks: new Map(), launches: [],
    prepared: new Set(), folderFailures: new Map(), unmanaged: new Map() })));
  assert.equal(f.run(child).reason, 'scope_invalidated');
  const requestId = f.run(child).requestId;
  const routed = await new ReturnRouter(f.root).pass(undefined, { project: f.project });
  const returns = f.store(s => s.readReturns().filter(r => r.requestId === requestId));
  assert.equal(returns.length, 1); assert.equal(returns[0]!.boundaryRunId, child.runId);
  const wake = f.store(s => routed.acceptedRequestIds.map(id => s.getRequest(id)!).find(r => r.taskId === x.id));
  assert.ok(wake?.runId);
  f.store(s => {
    s.prepareFolder(wake.runId!);
    const fd = openSync(join(s.folder(wake.runId!), RUN_FILES.managerLock), constants.O_RDWR | constants.O_CREAT, 0o600);
    assert.equal(tryLock(fd), true);
    t.after(() => { unlock(fd); closeSync(fd); });
  });
  return { f, x, y, child, requestId, wake, returns };
}
