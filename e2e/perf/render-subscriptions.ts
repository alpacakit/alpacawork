import { labelLayer } from '../editor-surface.ts';
/** Real application, deterministic notifications and real input/media/window actions.
 * Build: vite build --config e2e/perf/render-subscriptions.vite.ts --mode profiling
 * Run through test-queue: node --import ./e2e/guard-loader.mjs e2e/perf/render-subscriptions.ts OUTPUT
 * Store writes are diagnostic notifications, not claims about typical notification frequency.
 */
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium, expect, type Page } from '@playwright/test';
import type { WorkspaceStore } from '../../apps/web/src/data/workspace-store';
import type { useConversation } from '../../apps/web/src/features/coordinator/coordinator';
import { start } from '../server.ts';
import { patchTask, taskFolder } from '../fixture/task-state.ts';
import { SAMPLE_NOW } from '../fixture/sample.ts';
import { coordinatorConversationSchema } from '@alpacawork/contract/coordinator';

type Fiber = { tag: number; flags: number; alternate: Fiber | null; child: Fiber | null; sibling: Fiber | null; type: unknown };
type Phase = { commits: number; byName: Record<string, number> };
type Editor = { getJSON(): unknown; commands: { setContent(doc: unknown): boolean; focus(position: 'end'): boolean };
  state: { selection: { toJSON(): unknown } } };
declare global { interface Window {
  __renderProbeConversation: typeof useConversation; __renderProbeWorkspace: WorkspaceStore; __renderProbePhase: Phase;
} }
const output = resolve(process.argv[2]!);
mkdirSync(dirname(output), { recursive: true });
const results: unknown[] = [], errors: string[] = [];
const conversation = coordinatorConversationSchema.parse({ id: 'subscriptions', nextLaunch: { agent: 'claude', values: {} }, busy: false, earlier: null, resets: [], context: null, autoReset: { tokens: 200_000, percent: 50 },
  turns: Array.from({ length: 3 }, (_, n) => ({ id: `reply-${n}`, at: `2026-01-01T00:0${n}:00Z`, ask: `Request ${n}`,
    attachments: [], status: 'succeeded', waiting: false, seen: n < 2, error: null, result: null,
    answer: Array.from({ length: 20 }, (_, i) => `Paragraph ${i}: a stable answer for scrolling and read checks.\n\n`).join(''),
    answeredAt: `2026-01-01T00:0${n}:30Z` })) });
const runtime = await start(undefined, root => {
  copyFileSync(new URL('../fixture/swipe-clip.webm', import.meta.url), taskFolder(root, 'T111') + '/clip.webm');
}, dirname(output) + '/server');
const browser = await chromium.launch();
const expiry = setTimeout(() => { void browser.close(); }, 8 * 60_000);
const save = () => writeFileSync(output, JSON.stringify({ version: 1, sha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  browser: browser.version(), results, errors }, null, 2));
try {
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, locale: 'en-US', timezoneId: 'Asia/Tokyo',
      serviceWorkers: 'block', recordVideo: { dir: output + '.videos', size: { width, height: 900 } } });
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    const page = await context.newPage(); page.setDefaultTimeout(15000);
    page.on('pageerror', error => errors.push(`${width}: ${error.message}`));
    await page.clock.setFixedTime(new Date(SAMPLE_NOW));
    const original = await (await page.request.get(runtime.origin + '/api/coordinator')).json();
    const snapshot = { ...original, conversation };
    await page.route('**/api/coordinator', route => route.fulfill({ json: snapshot }));

    await page.route('**/api/coordinator/read', async route => {
      const data = route.request().postDataJSON();
      await route.fulfill({ json: { conversationId: conversation.id, seen: data.seen } });
    });
    await page.addInitScript(() => {
      const blank = () => ({ commits: 0, byName: {} });
      window.__renderProbePhase = blank();
      const named = (type: unknown): string => {
        if (typeof type === 'function') return type.name;
        if (type && typeof type === 'object') {
          if ('displayName' in type && typeof type.displayName === 'string') return type.displayName;
          if ('type' in type) return named(type.type);
          if ('render' in type) return named(type.render);
        }
        return 'Anonymous';
      };
      const walk = (fiber: Fiber) => {
        if ([0, 1, 11, 14, 15].includes(fiber.tag) && (!fiber.alternate || (fiber.flags & 1))) {
          const name = named(fiber.type); window.__renderProbePhase.byName[name] = (window.__renderProbePhase.byName[name] ?? 0) + 1;
        }
        if (fiber.alternate && fiber.alternate.child === fiber.child) return;
        for (let child = fiber.child; child; child = child.sibling) walk(child);
      };
      Object.defineProperty(window, '__REACT_DEVTOOLS_GLOBAL_HOOK__', { value: { renderers: new Map(), supportsFiber: true,
        isDisabled: false, checkDCE() {}, inject() { return 1; },
        onCommitFiberRoot(_id: number, root: { current: Fiber }) { window.__renderProbePhase.commits++; walk(root.current); },
        onCommitFiberUnmount() {}, onPostCommitFiberRoot() {}, onScheduleFiberRoot() {},
      } });
    });
    const run = async (name: string, work: () => Promise<unknown>) => {
      await page.waitForTimeout(350);
      await page.evaluate(() => { window.__renderProbePhase = { commits: 0, byName: {} }; });
      await work(); await page.waitForTimeout(100);
      results.push({ width, name, react: await page.evaluate(() => window.__renderProbePhase) }); save();
      console.log(width, name, JSON.stringify(await page.evaluate(() => window.__renderProbePhase)));
    };
    try {
      await page.goto(runtime.origin);
      await page.locator('li[data-row]').first().waitFor();
      await page.locator('[data-coordinator-expand]').first().click();
      const field = page.locator('[data-one-input]'); await field.waitFor();
      await field.evaluate(element => {
        const editor = (element as HTMLElement & { editor: Editor }).editor;
        editor.commands.setContent({ type: 'doc', content: [{ type: 'paragraph', content: [
          { type: 'taskLabel', attrs: { id: 'T112', title: 'Label task' } }, { type: 'text', text: ' words ' },
          { type: 'answerLabel', attrs: { task: 'T112', question: 'diagnostic', n: '1', name: 'Keep', answer: 'Keep' } },
          { type: 'text', text: ' tail' },
        ] }] });
        editor.commands.focus('end');
      });
      await expect(labelLayer(field).locator('[data-label=task]')).toHaveCount(1);
      await expect(labelLayer(field).locator('[data-label=answer]')).toHaveCount(1);
      await page.waitForTimeout(1000);
      const inputBefore = await field.evaluate(el => ({ doc: (el as HTMLElement & { editor: Editor }).editor.getJSON(),
        selection: (el as HTMLElement & { editor: Editor }).editor.state.selection.toJSON() }));
      for (let round = 0; round < 3; round++) {
        await run(`unrelated-workspace-${round}`, async () => {
          for (let n = 0; n < 20; n++) await page.evaluate(({ n, round }) => {
            const store = window.__renderProbeWorkspace, state = store.getState();
            store.setState({ tasks: state.tasks.map(task => task.id === 'T111' ? { ...task, title: `Other ${round}-${n}` } : task) });
          }, { n, round });
        });
        await run(`card-unrelated-view-${round}`, async () => {
          for (let n = 0; n < 20; n++) await page.evaluate(n => {
            window.__renderProbeConversation.setState({ pendingSeen: new Set([`diagnostic-${n}`]) });
          }, n);
          await page.evaluate(() => window.__renderProbeConversation.setState({ pendingSeen: new Set() }));
        });
      }
      const inputAfter = await field.evaluate(el => ({ doc: (el as HTMLElement & { editor: Editor }).editor.getJSON(),
        selection: (el as HTMLElement & { editor: Editor }).editor.state.selection.toJSON() }));
      expect(inputAfter).toEqual(inputBefore);
      await run('backend-unrelated-task', async () => {
        patchTask(runtime.root, 'T111', { values: { notes: `other task ${width}` } });
        await page.waitForTimeout(1800);
      });
      await run('relevant-task-state', async () => {
        await page.evaluate(() => {
          const store = window.__renderProbeWorkspace;
          store.setState({ tasks: store.getState().tasks.map(task => task.id === 'T112' ? { ...task, title: 'Changed label', state: 'held' as const } : task) });
        });
        await expect(labelLayer(field).locator('[data-label=task]')).toContainText('Changed label');
        await expect(labelLayer(field).locator('[data-label=answer]')).toHaveAttribute('data-held', 'true');
      });
      await field.press('End'); await page.keyboard.insertText(' input');
      const cdp = await context.newCDPSession(page);
      await cdp.send('Input.imeSetComposition', { text: 'にほん', selectionStart: 3, selectionEnd: 3 });
      await field.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229, isComposing: true, ctrlKey: true });
      await cdp.send('Input.insertText', { text: '日本' });
      await expect(field).toContainText('日本');
      expect(await page.evaluate(() => window.__renderProbeConversation.getState().conversation!.turns.length)).toBe(3);
      expect(await field.evaluate(el => document.activeElement === el)).toBe(true);
      const scroller = page.locator('[data-coordinator-panel] [data-card-scroll]').first();
      const scrollBefore = await scroller.evaluate(el => el.scrollTop);
      await scroller.hover(); await page.mouse.wheel(0, 300); await page.waitForTimeout(250);
      const scrollAfter = await scroller.evaluate(el => el.scrollTop);
      await scroller.click();
      await scroller.evaluate(el => { el.scrollTop = el.scrollHeight; });
      await expect.poll(() => page.evaluate(() => [...window.__renderProbeConversation.getState().seen])).toContain('reply-2');
      await page.screenshot({ path: `${output}.${width}.input.png` });
      results.push({ width, name: 'input-IME-selection-read-scroll', docPreserved: true, selectionPreserved: true,
        ime: '日本', noSend: true, scrollBefore, scrollAfter, seen: await page.evaluate(() => [...window.__renderProbeConversation.getState().seen]) }); save();
      if (width === 1440 && await page.locator('[data-coordinator-pop-out]').count()) {
        const before = await field.evaluate(el => (el as HTMLElement & { editor: Editor }).editor.getJSON());
        const opened = context.waitForEvent('page');
        await page.locator('[data-coordinator-pop-out]').click();
        const own = await opened;
        const ownField = own.locator('[data-one-input]'); await expect(ownField).toBeFocused();
        expect(await ownField.evaluate(el => (el as HTMLElement & { editor: Editor }).editor.getJSON())).toEqual(before);
        await own.keyboard.insertText(' own'); await own.screenshot({ path: `${output}.${width}.own.png` }); await own.close();
        await expect(field).toContainText('own'); await expect(field).toBeFocused();
        results.push({ width, name: 'own-window', draftAndFocus: true }); save();
      }
      await page.goto(`${runtime.origin}/?agent=1&task=T111&tab=files&image=clip.webm`);
      const video = page.locator('[data-image-slider-modal] video[data-image-slider-large]');
      await expect.poll(() => video.evaluate((el: HTMLVideoElement) => el.readyState)).toBeGreaterThanOrEqual(2);
      await video.evaluate((el: HTMLVideoElement) => el.pause()); await page.waitForTimeout(200);
      for (let round = 0; round < 3; round++) await run(`video-equal-events-${round}`, async () => {
        for (let n = 0; n < 20; n++) await video.evaluate(el => el.dispatchEvent(new Event('timeupdate')));
      });
      await page.locator('[data-video-play]').click();
      await expect.poll(() => video.evaluate((el: HTMLVideoElement) => el.currentTime)).toBeGreaterThan(.3);
      await page.locator('[data-video-play]').click();
      expect(await video.evaluate((el: HTMLVideoElement) => el.paused)).toBe(true);
      await page.locator('[data-video-speed]').selectOption('2');
      await expect.poll(() => video.evaluate((el: HTMLVideoElement) => el.playbackRate)).toBe(2);
      await page.locator('[data-video-mute]').click();
      expect(await video.evaluate((el: HTMLVideoElement) => el.muted)).toBe(true);
      await page.locator('[data-video-seek]').fill('3');
      await expect.poll(() => video.evaluate((el: HTMLVideoElement) => el.currentTime)).toBeGreaterThanOrEqual(2.9);
      await page.screenshot({ path: `${output}.${width}.video.png` });
      results.push({ width, name: 'video-real-playback', observed: await video.evaluate((el: HTMLVideoElement) => ({ paused: el.paused,
        time: el.currentTime, duration: el.duration, speed: el.playbackRate, muted: el.muted })) }); save();
    } catch (error) {
      await page.screenshot({ path: `${output}.${width}.failure.png` });
      writeFileSync(`${output}.${width}.failure.html`, await page.content());
      throw error;
    } finally {
      await context.tracing.stop({ path: `${output}.${width}.trace.zip` }); await context.close();
    }
  }
  expect(errors).toEqual([]);
} finally { save(); clearTimeout(expiry); await browser.close(); await runtime.stop(); }
