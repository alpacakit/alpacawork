/** A real accepted child Request ends through scope invalidation; history, not a handmade DTO, feeds Reader. */
import { test as base, expect, settleMotion } from './fixtures.ts';
import { invalidationHistory } from '../tests/invalidation-history.fixture.ts';
import { startServer } from './fixture/server.ts';
import { withRuntimeEvidence } from './failure-evidence.ts';

type Source = Awaited<ReturnType<typeof invalidationHistory>> & { origin: string };
const test = base.extend<{ invalidation: Source }>({
  invalidation: async ({}, use, info) => {
    const cleanup: (() => void)[] = [];
    const source = await invalidationHistory({ after: fn => cleanup.push(fn) });
    const server = await startServer(source.f.root, 0);
    const expiry = setTimeout(() => void server.close(), 120_000); expiry.unref();
    const runtime = { root: source.f.root, origin: new URL(server.url).origin };
    await withRuntimeEvidence(runtime, info, () => use({ ...source, origin: runtime.origin }), [
      { name: 'stop', run: async () => { clearTimeout(expiry); await server.close(); } },
      ...cleanup.reverse().map((dispose, index) => ({ name: `dispose-${index}`, run: async () => { dispose(); } })),
    ]);
  },
  runtime: async ({ invalidation }, use) => use({ root: invalidation.f.root, origin: invalidation.origin }),
});

// Language picks the words and nothing else; a phone's is the sheet at either width, 320px the tighter. One of each.
for (const [language, width] of [['en', 1440]] as ['en' | 'ja', number][]) test.describe(`scope invalidation history ${language}`, () => {
  test.use({ locale: language === 'ja' ? 'ja-JP' : 'en-US' });
  test(`real reason and IDs survive Reader navigation and reload at ${width}px`, async ({ page, runtime, invalidation: h }, info) => {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
    await page.clock.setFixedTime(new Date(Date.parse(h.f.run(h.child).ended_at!) + 60_000));
    const posts: string[] = [];
    page.on('request', r => { if (r.method() === 'POST') posts.push(new URL(r.url()).pathname); });
    await page.goto(runtime.origin + `/?agent=1&q=Accepted%20child%20Y`);
    await expect(page.locator('html')).toHaveAttribute('lang', language);
    const read = page.locator(`[data-result="${h.y.id}"]`), key = `run:${h.child.runId}:finished`;
    const reason = language === 'en' ? 'The task scope changed after the request was accepted, so this work ended without starting.'
      : '依頼を受け付けた後で作業の範囲が変わったため、開始せずに終わりました。';
    const row = page.locator(`[data-report-key="${key}"]`);
    await read.click(); await settleMotion(page); await expect(page.locator('[data-reader-task-id]')).toHaveText(h.y.id);
    await expect(row).toContainText(reason); await expect(row).toBeVisible();
    const words = await row.locator('[data-row-words]').evaluate(e => ({ client: e.clientHeight, scroll: e.scrollHeight }));
    expect(words.scroll).toBeLessThanOrEqual(words.client);
    const request = page.locator(`[data-report-key="request:${h.requestId}"]`);
    await expect(request).toContainText('Do the work');
    const api = await (await page.request.get(runtime.origin + `/api/task/history?task=${h.y.id}&children=1&limit=80`)).json();
    expect(api.events.filter((e: { id: string }) => e.id === h.child.runId)).toEqual([
      // The Run that ended writes its row: the Task's responsible, by what it ran with (none recorded here).
      { id: h.child.runId, kind: 'run_end', taskId: h.y.id, fromChild: false, at: h.f.run(h.child).ended_at,
        state: null, by: null, author: { kind: 'owner', profileKey: 'fake', modelId: null, effort: null }, title: 'scope_invalidated', summary: '' },
    ]);
    expect(api.events.find((e: { id: string }) => e.id === h.requestId).kind).toBe('request');
    await info.attach('real-scope-reason', { body: await page.locator('aside[data-reader-mode]').screenshot(), contentType: 'image/png' });
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^(Close run|終了する)$/ })).toHaveCount(0);
    await page.goBack(); await settleMotion(page); await expect(page.locator('[data-reader-task-id]')).toHaveCount(0); await expect(read).toBeFocused();
    await read.press('Enter'); await settleMotion(page); await expect(row).toContainText(reason);
    await page.keyboard.press('Escape'); await settleMotion(page); await expect(read).toBeFocused();
    await read.press('Space'); await settleMotion(page); await expect(row).toContainText(reason);
    await page.keyboard.press('Escape'); await settleMotion(page); await expect(read).toBeFocused();
    const direct = runtime.origin + `/?agent=1&q=Accepted%20child%20Y&task=${h.y.id}&event=${encodeURIComponent(key)}`;
    await page.goto(direct); await expect(row).toBeVisible(); await settleMotion(page); await expect(row).toContainText(reason); await page.reload(); await expect(row).toBeVisible(); await settleMotion(page);
    await expect(row).toContainText(reason); expect(new URL(page.url()).searchParams.get('event')).toBe(key);
    // Follow the same accepted Request within the existing Reader, then return to its Run's finished identity.
    await request.getByRole('button', { expanded: false }).first().click(); await settleMotion(page);
    await expect(request.getByRole('button', { expanded: true }).first()).toBeVisible();
    await expect(request).toContainText('Do the work');
    // The accepted Request and its Run remain separately addressable read destinations.
    await page.goto(direct); await expect(row).toBeVisible(); await settleMotion(page);
    await page.goto(runtime.origin + `/?agent=1&q=Accepted%20child%20Y&task=${h.y.id}&event=request:${h.requestId}`);
    await expect(request).toContainText('Do the work'); await settleMotion(page);
    await expect.poll(() => new URL(page.url()).searchParams.get('event')).toBe(`request:${h.requestId}`);
    // A direct URL has no clicked opener; closing it returns to its search list.
    await page.keyboard.press('Escape'); await settleMotion(page); await expect(page.locator('[data-reader-task-id]')).toHaveCount(0);
    await page.goto(direct); await expect(row).toContainText(reason); await settleMotion(page);
    const bounds = await page.locator('[data-reader-content]').evaluate(e => ({ client: e.clientWidth, scroll: e.scrollWidth }));
    expect(bounds.scroll).toBeLessThanOrEqual(bounds.client);
    await page.keyboard.press('Escape'); await settleMotion(page); await expect(page.locator('[data-reader-task-id]')).toHaveCount(0);
    await page.goto(runtime.origin + '/?agent=1&q=Moved%20ancestor%20X');
    const parentRead = page.locator(`[data-result="${h.x.id}"]`);
    await parentRead.click(); await settleMotion(page); await expect(row).toContainText(reason);
    await page.keyboard.press('Escape'); await settleMotion(page); await expect(parentRead).toBeFocused();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(posts.filter(p => ['/api/commands/run/stop', '/api/commands/task/report'].includes(p))).toEqual([]);
    await info.attach('scope-history-observed', { body: JSON.stringify({ language, width, task: h.y.id, requester: h.x.id,
      runId: h.child.runId, requestId: h.requestId, eventKey: key, expectedReason: reason, bounds, words,
      history: api, stopOrReportPosts: posts.filter(p => ['/api/commands/run/stop', '/api/commands/task/report'].includes(p)) }), contentType: 'application/json' });
  });
});
