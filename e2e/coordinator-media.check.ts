
import { test as base, expect } from './fixtures.ts';
import { copyFileSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startServer } from './fixture/server.ts';
import { generate } from './fixture/generate.ts';
import { seedReview, taskFolder } from './fixture/task-state.ts';
import { configureCoordinator, revealReplies, readyCoordinator } from './coordinator-fixture.ts';
import { open, openCoordinator } from './fixtures.ts';
import type { Runtime } from './server.ts';

const test = base.extend<{ runtime: Runtime & { restart: () => Promise<void>; publish: () => void } }>({
  // A live page can reconnect its event stream while serve is closing. Release this fixture's
  // browser clients before its server; the inherited context still supplies all device options.
  context: async ({ context, runtime: _runtime }, use) => {
    try { await use(context); } finally { await context.close(); }
  },
  runtime: async ({}, use) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'alpacawork-e2e-')));
    generate(root);
    // This server runs in the worker, rather than server.ts's isolated child. Its admissions
    // must resolve built-in commands through this workspace's stubs for the whole lifetime.
    const previousPath = process.env.PATH;
    process.env.PATH = configureCoordinator(root);
    // A request in flight as serve closes leaves its connection open until the browser lets it go (keepAliveTimeout 0), and
    // that close finishes only when the context does, below. What this case checks is the restarted serve, so it does not wait.
    const closings: Promise<unknown>[] = [];
    try {
      let server = await startServer(root, 0);
      const port = Number(new URL(server.url).port);
      const expiry = setTimeout(() => void server.close(), 10 * 60_000);
      try {
        const runtime = { root, origin: new URL(server.url).origin, publish: () => server.filesChanged(), restart: async () => { const closing = server.close(); closings.push(closing); await Promise.race([closing, new Promise(resolve => setTimeout(resolve, 10_000))]); server = await startServer(root, port); } };
        await use(runtime);
      } finally { clearTimeout(expiry); await server.close(); await Promise.all(closings); }
    } finally {
      if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
      rmSync(root, { recursive: true, force: true });
    }
  },
});

test.use({ fixedTime: false }); // Preserve the real clock these host-time delivery cases used with Playwright base.
for (const phone of [false]) test.describe(phone ? 'phone' : 'pc', () => {
  test.use({ actionTimeout: 10000, navigationTimeout: 10000, viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, hasTouch: phone, isMobile: phone });
  for (const historyDelay of [0]) test(`answer images, video and files share report rendering and survive source removal, reload and serve restart${historyDelay ? ' with delayed History' : ''}`, async ({ page, runtime }, info) => {
    test.setTimeout(120_000);
    const source = realpathSync(mkdtempSync(join(tmpdir(), 'answer-preview-')));
    try {
      const png = readFileSync(new URL('./fixture/wide-report.png', import.meta.url));
      writeFileSync(join(source, 'screen.png'), png);
      copyFileSync(new URL('./fixture/swipe-clip.webm', import.meta.url), join(source, 'clip.webm'));
      writeFileSync(join(source, 'note.txt'), 'Opened the attached file.');
      const folder = taskFolder(runtime.root, 'T112');
      writeFileSync(join(folder, 'screen.png'), png);
      copyFileSync(join(source, 'clip.webm'), join(folder, 'clip.webm'));
      writeFileSync(join(folder, 'note.txt'), 'Report document body: REPORT-BODY-MARK');
      runtime.publish();
      seedReview(runtime.root, 'T112', { title: 'Shared images, videos and files', description: '![Report image](screen.png)\n![Report video](clip.webm)\n[Report file](note.txt)' });
      const viewed = await page.request.get(`${runtime.origin}/api/task/view?task=T112`);
      expect(viewed.status(), await viewed.text()).toBe(200);
      const savedReport = (await viewed.json()).task.log.find((log: { title: string }) => log.title === 'Shared images, videos and files');
      expect(savedReport).toBeTruthy();
      const answer = `You can review images, videos and files.\n\n![Conversation image](${source}/screen.png)\n![Conversation video](${source}/clip.webm)\n[Attachment description](${source}/note.txt)\n\n![Task image](${runtime.origin}/api/tasks/T112/file?path=screen.png)\n![Task absolute-path image](${folder}/screen.png)\n![Task relative-URL image](/api/tasks/T112/file?path=screen.png)\n![Task video](/api/tasks/T112/file?path=clip.webm)\n[Task file](${folder}/note.txt)\n[Open Task URL image](${runtime.origin}/api/tasks/T112/file?path=screen.png)`;
      const replyPath = join(runtime.root, 'answer.md'); writeFileSync(replyPath, answer);
      // Delay the first History read, including the one made by the initial Reader. Later visits reuse it.
      let delayedHistoryReads = 0;
      if (historyDelay) await page.route('**/api/task/history?*', async route => {
        delayedHistoryReads++;
        await new Promise(resolve => setTimeout(resolve, historyDelay));
        await route.continue();
      });
      await open(page, runtime, '?agent=1&task=T112');
      await openCoordinator(page);
      const card = page.locator('[data-coordinator-card]');
      const input = card.getByRole('textbox', { name: 'Message the coordinator' });
      await expect(input).toHaveAttribute('contenteditable', 'true');
      await readyCoordinator(page, runtime);
      await input.fill('Show the attached sample.');
      await card.locator('[data-ask-send]').click();
      const panel = page.locator('[data-coordinator-panel]');
      const body = panel.locator('[data-ask-answer]');
      const check = async () => {
        for (const name of ['Conversation image', 'Task image', 'Task absolute-path image', 'Task relative-URL image']) {
          const image = body.getByRole('img', { name, exact: true });
          await expect(image).toBeVisible();
          await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
        }
        const link = body.getByRole('link', { name: /^Attachment description/ });
        await expect(link).toBeVisible();
        const href = await link.getAttribute('href', { timeout: 5000 });
        expect(await (await page.request.get(new URL(href!, runtime.origin).href)).text()).toBe('Opened the attached file.');
        const popupWait = page.waitForEvent('popup'); await link.click(); const popup = await popupWait;
        await expect(popup.locator('body')).toContainText('Opened the attached file.'); await popup.close();
        const poster = body.locator('[data-report-image-trigger]').filter({ has: page.locator('video') });
        for (let i = 0; i < await poster.count(); i++) {
          await poster.nth(i).click();
          const video = page.locator('[data-image-slider-modal] video[data-image-slider-large]');
          await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThanOrEqual(2);
          await video.evaluate(async (v: HTMLVideoElement) => { v.muted = true; await v.play(); });
          await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(.2);
          await video.evaluate((v: HTMLVideoElement) => v.pause());
          await page.keyboard.press('Escape');
        }
      };
      await check();
      const saved = (await (await page.request.get(`${runtime.origin}/api/coordinator`)).json()).conversation;
      const turn = saved.turns.find((turn: { answer: string }) => turn.answer === answer);
      expect(turn.answer).toBe(answer);
      expect(turn.answerFiles).toHaveLength(3);
      expect(turn.answerFiles.every((file: { href: string }) => file.href.startsWith(source))).toBe(true);
      await body.getByRole('button', { name: 'Task absolute-path image', exact: true }).click();
      await expect.poll(() => page.locator('[data-image-slider-large]').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
      await page.keyboard.press('Escape');
      rmSync(source, { recursive: true, force: true });
      // An agent view records no read: show the latest reply and reveal earlier unread replies on reload.
      await page.reload(); await openCoordinator(page); await revealReplies(page); await check();
      // This case checks persisted media after restart. Release the old document's SSE/media requests
      // before draining its in-process server, just as the runtime's teardown releases its clients.
      const resumeUrl = page.url();
      await page.goto('about:blank');
      await runtime.restart();
      await page.goto(resumeUrl); await openCoordinator(page); await revealReplies(page); await check();
      expect(await panel.locator('[data-card-scroll]').evaluate(el => el.scrollWidth - el.clientWidth)).toBe(0);
      await panel.locator('[data-card-scroll]').evaluate(el => { el.scrollTop = 0; });
      await body.getByRole('img', { name: 'Conversation image', exact: true }).scrollIntoViewIfNeeded();
      await panel.screenshot({ path: info.outputPath('coordinator-card.png') });
      await body.screenshot({ path: info.outputPath('coordinator-answer.png') });
      await page.screenshot({ path: info.outputPath('coordinator-screen.png') });
      await body.getByRole('link', { name: 'Open Task URL image', exact: true }).click();
      await expect.poll(() => page.locator('[data-image-slider-large]').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
      expect(new URL(page.url()).searchParams.get('agent')).toBe('1');
      const reportKey = `log:T112:${savedReport.id}`;
      await open(page, runtime, `?agent=1&task=T112&event=${encodeURIComponent(reportKey)}`);
      // The existing report still uses the same image viewer, video player and Task file links.
      const reader = page.getByRole('complementary');
      const report = reader.locator(`[data-report-key="${reportKey}"] button[aria-expanded]`).first();
      await expect(report).toHaveAttribute('aria-expanded', 'true');
      const reportImage = reader.getByRole('img', { name: 'Report image', exact: true });
      await expect(reportImage).toBeVisible();
      await expect.poll(() => reportImage.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
      if (historyDelay) expect(delayedHistoryReads).toBeGreaterThan(0);
      const actual = reader.locator('video[aria-label="Report video"]');
      await expect.poll(() => actual.evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThanOrEqual(2);
      await actual.evaluate(async (v: HTMLVideoElement) => { v.muted = true; await v.play(); });
      await expect.poll(() => actual.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(.2);
      await actual.evaluate((v: HTMLVideoElement) => v.pause());
      await reader.getByRole('link', { name: 'Report file', exact: true }).click();
      await expect(reader.getByText('Report document body: REPORT-BODY-MARK', { exact: true })).toBeVisible();
    } finally { rmSync(source, { recursive: true, force: true }); }
  });

});
