/** Real server + canonical dependency commands + synthetic/inert fixtures, at both selected proposal widths. */
import { test as base, expect, settleMotion } from './fixtures.ts';
import { dependencyDisplay } from '../tests/dependency-display.fixture.ts';
import { startServer } from './fixture/server.ts';
import { withRuntimeEvidence } from './failure-evidence.ts';

type Scene = Awaited<ReturnType<typeof dependencyDisplay>> & { origin: string };
const test = base.extend<{ dependencies: Scene }>({
  dependencies: async ({}, use, info) => {
    const cleanup: (() => void)[] = [];
    const scene = await dependencyDisplay({ after: fn => cleanup.push(fn) });
    const server = await startServer(scene.f.root, 0);
    const runtime = { root: scene.f.root, origin: new URL(server.url).origin };
    const expiry = setTimeout(() => void server.close(), 120_000); expiry.unref();
    await withRuntimeEvidence(runtime, info, () => use({ ...scene, origin: runtime.origin }), [
      { name: 'stop', run: async () => { clearTimeout(expiry); await server.close(); } },
      ...cleanup.reverse().map((dispose, index) => ({ name: `dispose-${index}`, run: async () => { dispose(); } })),
    ]);
  },
  runtime: async ({ dependencies }, use) => use({ root: dependencies.f.root, origin: dependencies.origin }),
});

for (const width of [1440]) test.describe(`dependency display at ${width}px`, () => {
  test.use({ locale: 'ja-JP', viewport: { width, height: width === 1440 ? 900 : 844 } });
  test('waiters first heading and × stay above scrolling rows without a separate header', async ({ page, runtime, dependencies: s }) => {
    const target = s.cleared.id, others: string[] = [];
    for (let i = 0; i < 22; i++) others.push(await s.f.plan(`スクロール確認 ${i + 1}`));
    const set = async (task: string, after: string[]) => s.f.commands.dependencies({ task, after, expectedTaskHash: (await s.f.get(task)).hash });
    for (const id of others) await set(id, [target]);
    await page.goto(`${runtime.origin}/?agent=1&task=${target}`);
    const entry = page.locator('aside [data-reader-panel-entry="dependencies"]');
    await entry.click();
    const panel = page.getByRole('dialog', { name: '依存', exact: true });
    const head = panel.locator('[data-order-head]'), scroll = panel.locator('[data-order-scroll]');
    await expect(panel.getByText('依存', { exact: true })).toHaveCount(0);
    await expect(head.locator('h3')).toHaveText('後続 22件');
    const close = head.getByRole('button', { name: '閉じる', exact: true });
    await expect(panel.getByRole('button', { name: '閉じる', exact: true })).toHaveCount(1);
    await expect(panel.locator('[data-order-task]')).toHaveCount(22);
    await settleMotion(page);
    const at = (await head.boundingBox())!;
    expect(await scroll.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
    await scroll.evaluate(el => { el.scrollTop = el.scrollHeight; });
    await expect.poll(() => scroll.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
    await expect.poll(() => head.evaluate(el => getComputedStyle(el, '::after').content)).not.toBe('none');
    expect((await head.boundingBox())!.y).toBeCloseTo(at.y, 0);
    await expect(close).toBeInViewport();
    expect(await head.evaluate(el => {
      const box = el.getBoundingClientRect(), missed: string[] = [];
      for (let x = box.left + 2; x < box.right - 1; x += 12)
        for (const y of [box.top + 1, (box.top + box.bottom) / 2, box.bottom - 1])
          if (!document.elementFromPoint(x, y)?.closest('[data-order-head], [data-sheet-grip]')) missed.push(`${Math.round(x)},${Math.round(y)}`);
      return missed;
    })).toEqual([]);
    const first = panel.locator('[data-order-task]').first();
    // Opening already focused the first row; move focus before asking the browser to reveal it again.
    await panel.locator('[data-order-task]').nth(1).focus();
    await first.focus();
    expect((await first.boundingBox())!.y).toBeGreaterThanOrEqual((await head.boundingBox())!.y + (await head.boundingBox())!.height - 0.5);
    await close.click();await expect(panel).toHaveCount(0);await expect(entry).toBeFocused();
    await entry.click();await expect(panel).toHaveCount(1);await page.keyboard.press('Escape');await expect(panel).toHaveCount(0);
  });
});
