/** The actual list, actual Run boundaries and SSE updates, without launching an agent or touching a live workspace. */
import { test, expect, settleMotion } from './fixtures.ts';
import { handlingFixture } from '../tests/return-handling.fixture.ts';
import { startServer } from './fixture/server.ts';
import { constants, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { tryLock, unlock } from '@alpacawork/core';
import { RUN_FILES } from '@alpacawork/contract/run';

const active = test.extend<{ execution: Awaited<ReturnType<typeof handlingFixture>> & { member: string } }>({
  fixedTime: false,
  execution: async ({}, use) => {
    const cleanup: (() => unknown)[] = [], h = await handlingFixture({ after: fn => cleanup.push(fn) });
    try {
      await h.commands.update({ id: h.task.id, title: 'Member executing the same task', userRequested: true, expectedTaskHash: (await h.current()).hash });
      const owner = await h.human(); await h.start(owner.runId);
      const member = await h.delegate(owner.runId); await h.start(member.runId); h.end(owner.runId); h.reconcile();
      await use({ ...h, member: member.runId });
    } finally { for (const dispose of cleanup.reverse()) await dispose(); }
  },
  runtime: async ({ execution: h, context }, use) => {
    h.store.prepareFolder(h.member);
    const lock = openSync(join(h.store.folder(h.member), RUN_FILES.managerLock), constants.O_RDWR | constants.O_CREAT, 0o600);
    expect(tryLock(lock)).toBe(true);
    let server: Awaited<ReturnType<typeof startServer>> | undefined;
    try {
      server = await startServer(h.root, 0);
      await use({ root: h.root, origin: new URL(server.url).origin });
    } finally {
      // This fixture owns an in-process server. Release SSE/keep-alive clients before draining it.
      try { await context.close(); }
      finally { try { await server?.close(); } finally { unlock(lock); closeSync(lock); } }
    }
  },
});

for (const width of [1440]) active(`same-task activity and owner resumption update the formal list at ${width}px`, async ({ page, runtime, execution: h }) => {
  await page.setViewportSize({ width, height: 900 });
  const live = async () => (await page.request.get(runtime.origin + '/api/workspace/live')).json();
  await page.goto(runtime.origin + `/?agent=1&project=${h.project}`);
  const row = page.locator(`[data-row="${h.task.id}"]`), status = row.locator('[data-row-status]');
  await expect(row).toBeVisible(); await expect(status).toHaveAttribute('data-row-status', 'running');
  await expect(page.locator('[data-section="awaited"]')).toHaveCount(0);
  const first = await live();
  expect(first.home.find((r: { taskId: string }) => r.taskId === h.task.id).section).toBe('doing');
  expect(first.tasks.find((r: { id: string }) => r.id === h.task.id).rowFacts.status.kind).toBe('running');
  await settleMotion(page);
  const before = await row.locator(':scope > [data-row-head]').boundingBox();
  await row.locator(`[data-read="${h.task.id}"]`).click();
  await expect(page.locator('[data-reader-task-id]')).toHaveText(h.task.id);
  await expect(page.locator(`[data-report-key="request:${h.store.get(h.member)!.requestId}"]`)).toContainText('Investigate');
  await page.goBack(); await expect(page.locator('[data-reader-task-id]')).toHaveCount(0);

  // No reload: the real store boundary must invalidate and publish the new projection.
  h.end(h.member);
  // Route through the same ReturnRouter, then claim the simulated manager before waiting on browser publication.
  // Waiting for the queued row first lets serve's real scheduler legitimately claim this inert fixture Run.
  await h.pass();
  const next = h.store.read().find(run => run.role === 'owner' && run.state === 'queued');
  expect(next).toBeTruthy();
  h.store.prepareFolder(next!.id);
  const lock = openSync(join(h.store.folder(next!.id), RUN_FILES.managerLock), constants.O_RDWR | constants.O_CREAT, 0o600);
  expect(tryLock(lock)).toBe(true);
  try {
    await expect(status).toHaveAttribute('data-row-status', 'queued');
    await h.start(next!.id);
    await expect(status).toHaveAttribute('data-row-status', 'running');
    await expect.poll(async () => (await live()).tasks.find((r: { id: string }) => r.id === h.task.id).rowFacts.status.kind).toBe('running');
    await expect(page.locator('[data-section="awaited"]')).toHaveCount(0);
    await settleMotion(page);
    const after = await row.locator(':scope > [data-row-head]').boundingBox();
    expect(after?.height).toBe(before?.height);
  } finally { unlock(lock); closeSync(lock); }
});
