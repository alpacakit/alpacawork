/** Explicit integration check: common synthetic workspace, real HTTP persistence and real PC/phone UI. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium, expect } from '@playwright/test';
import { RunStore } from '@alpacawork/runs';
import { CoordinatorConversation } from '@alpacawork/backend/test-dist/coordinator/conversation.js';
import { startServer } from '@alpacawork/backend/test-dist/receiver/server.js';
import { createOriginal, copyWorkspace, profiles, removeWorkspace } from './fixture.ts';

for (const width of [1440, 390]) test(`unread history reads the captured conversation and preserves position (${width}px)`, { timeout: 120_000 }, async () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'coordinator-history-'));
  const evidence = process.env.COORDINATOR_READ_EVIDENCE;
  const browser = await chromium.launch();
  const original = createOriginal({ ...profiles.small, seed: 'coordinator-history' }, join(sandbox, 'cache'));
  const copy = copyWorkspace(original.root, join(sandbox, 'workspace'));
  const conversation = new CoordinatorConversation(copy.root);
  // Seed before replies; startup must not make the fixture's history read.
  await conversation.seedSeen();
  const id = conversation.read().id;
  const arriving = crypto.randomUUID();
  const ids: string[] = [];
  try {
    for (let n = 1; n <= 133; n++) {
      const request = crypto.randomUUID(); ids.push(request);
      await conversation.ask({ conversationId: id, id: request, text: `Synthetic question ${n}`, attachments: [], selected: {} });
      const store = new RunStore(copy.root, { busyTimeoutMs: 1000 });
      try {
        const run = store.coordinatorRuns(id).find(run => run.requestId === request)!;
        store.write(tx => {
          tx.update({ ...run, state: 'running', started_at: '2026-11-01T00:00:00Z' });
          tx.finish({ ...run, state: 'succeeded', started_at: '2026-11-01T00:00:00Z', ended_at: '2026-11-01T00:00:01Z' },
            { state: 'present', text: Array.from({ length: 12 }, (_, p) => `Synthetic answer ${n}, paragraph ${p + 1}. Follow earlier conversation without moving these words.`).join('\n\n') });
        });
      } finally { store.close(); }
    }
    await conversation.markSeen(id, ids.slice(0, 3));
    const app = await startServer(copy.root, 0);
    try {
      const context = await browser.newContext({ viewport: { width, height: 900 }, isMobile: width === 390, hasTouch: width === 390 });
      const page = await context.newPage();
      if (evidence) await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
      try {
        const get = async () => (await (await page.request.get(new URL('/api/coordinator', app.url).href)).json()).conversation;
        await page.goto(app.url);
        await page.locator('[data-coordinator-expand]').first().click();
        const panel = page.locator('[data-coordinator-panel]');
        const row = panel.locator('[data-earlier]');
        const latest = panel.locator(`[data-coordinator-message="${ids.at(-1)}"] [data-sent-message]`);
        await expect(row).toContainText('132 earlier messages');
        await expect(panel.locator('[data-coordinator-turn]')).toHaveCount(1);
        await page.waitForTimeout(400);
        if (evidence) {
          mkdirSync(evidence, { recursive: true });
          await panel.screenshot({ path: join(evidence, `before-${width}.png`) });
        }
        const before = (await latest.boundingBox())!.y;
        const beforeFacts = await get();
        assert.equal(beforeFacts.turns.filter((turn: any) => !turn.seen).length, 130);
        let release!: () => void;
        const held = new Promise<void>(resolve => { release = resolve; });
        const submitted: string[][] = [];
        // Phone exercises a real failure first; PC holds the ACK while a new reply arrives.
        let fail = width === 390;
        await page.route('**/api/coordinator/read', async route => {
          submitted.push(route.request().postDataJSON().seen);
          if (fail) { fail = false; await route.abort('failed'); return; }
          await held; await route.continue();
        });
        // The label and the same row's Open are the one native button.
        if (width === 390) await row.locator('button > span').last().click();
        else await row.locator('button > .font-medium').click();
        await expect(panel.locator('[data-coordinator-turn]')).toHaveCount(133);
        await expect(panel.locator('[data-earlier]')).toHaveCount(0);
        await expect.poll(() => submitted.length).toBe(1);
        await page.waitForTimeout(400);
        const after = (await latest.boundingBox())!.y;
        assert.ok(Math.abs(after - before) < 2, JSON.stringify({ before, after }));
        assert.equal((await get()).turns.filter((turn: any) => !turn.seen).length, 130, 'no success before a saved ACK');
        if (width === 390) {
          await page.waitForTimeout(300);
          assert.equal(submitted.length, 1, 'failure does not retry through its own rendering');
          // A new human input resumes the existing pending receipt, rather than inventing another read state.
          await panel.locator('[data-card-scroll]').evaluate(element => element.scrollTo({ top: 0 }));
          const message = panel.locator(`[data-coordinator-message="${ids[3]}"] [data-sent-message]`);
          await message.click();
          await expect.poll(() => submitted.length).toBe(2);
        }
        const response = await page.request.post(new URL('/api/coordinator/messages', app.url).href,
          { data: { conversationId: id, id: arriving, text: 'Synthetic new arrival', attachments: [] } });
        assert.equal(response.status(), 200);
        await expect.poll(async () => (await get()).turns.find((turn: any) => turn.id === arriving)?.answeredAt).toBeTruthy();
        release();
        await expect.poll(async () => (await get()).turns.filter((turn: any) => ids.includes(turn.id) && turn.seen).length).toBe(133);
        assert.equal((await get()).turns.find((turn: any) => turn.id === arriving).seen, false);
        assert.ok(submitted.every(batch => !batch.includes(arriving)));
        const actual = new Set(submitted.flat()); assert.equal(actual.size, 130);
        await expect(row).toHaveCount(0);
        await expect(panel.locator('[data-earlier]')).toHaveCount(0);
        if (evidence) {
          mkdirSync(evidence, { recursive: true });
          await panel.locator('[data-card-scroll]').evaluate(element => element.scrollTo({ top: 0 }));
          await page.waitForTimeout(100);
          await panel.screenshot({ path: join(evidence, `history-${width}.png`) });
          const panelBox = (await panel.boundingBox())!, rowBox = (await panel.locator('[data-coordinator-turn]').first().boundingBox())!;
          writeFileSync(join(evidence, `mark-${width}.json`), JSON.stringify({ x: rowBox.x - panelBox.x, y: rowBox.y - panelBox.y, width: rowBox.width, height: rowBox.height }));
          writeFileSync(join(evidence, `history-${width}.json`), JSON.stringify({ width, before, after, submitted, seen: (await get()).turns.map((turn: any) => ({ id: turn.id, seen: turn.seen })) }, null, 2));
        }
        // Revealed history stays shown as new replies arrive; there is no group fold control.
        await expect(panel.locator('[data-coordinator-turn]')).toHaveCount(134);
        await expect(panel.locator('[data-earlier]')).toHaveCount(0);
        await page.waitForTimeout(300);
        assert.equal((await get()).turns.find((turn: any) => turn.id === arriving).seen, false);
        assert.ok(submitted.every(batch => !batch.includes(arriving)));
        // A second device and a reload consume the persisted union, with the new arrival still unread.
        const other = await context.newPage(); await other.goto(new URL('/?agent=1', app.url).href);
        const check = await other.request.get(new URL('/api/coordinator', app.url).href);
        const saved = (await check.json()).conversation.turns;
        assert.equal(saved.filter((turn: any) => turn.seen).length, 133);
        assert.equal(saved.at(-1).seen, false);
        await other.close(); await page.reload();
        await page.locator('[data-coordinator-expand]').first().click();
        await expect(page.locator('[data-coordinator-panel] [data-coordinator-message]')).toHaveCount(1);
        // Latest opens the actual new exchange; reading older history did not leave the next opening behind.
        await expect(page.locator(`[data-coordinator-message="${arriving}"]`)).toBeVisible();
        if (evidence) await context.tracing.stop();
      } catch (error) {
        if (evidence) {
          mkdirSync(evidence, { recursive: true });
          await page.screenshot({ path: join(evidence, `failure-${width}.png`) }).catch(() => {});
          await context.tracing.stop({ path: join(evidence, `failure-${width}.zip`) }).catch(() => {});
        }
        throw error;
      } finally { await context.close(); }
    } finally { await app.close(); }
  } finally {
    await browser.close(); removeWorkspace(copy.root); removeWorkspace(original.root); rmSync(sandbox, { recursive: true, force: true });
  }
});
