/** Native press to finished motion on the common perf fixture. Timing runs and --profile runs stay separate. */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadavg } from 'node:os';
import { chromium, type Browser, type Locator } from '@playwright/test';
import { copyWorkspace, createOriginal, profiles, removeWorkspace } from '../../scripts/dev-fixtures/fixture.ts';

/** The conversation's ⌄ (a phone has one too), else Esc. */
async function foldChat(page: any, press: (target: any) => Promise<unknown> = target => target.click()) {
  const fold = page.locator('[data-coordinator-panel] [data-coordinator-fold]').first();
  if (await fold.count()) await press(fold); else await page.keyboard.press('Escape');
}

const { values: args } = parseArgs({ options: {
  release: { type: 'string' }, out: { type: 'string' }, rounds: { type: 'string', default: '6' },
  throttle: { type: 'string', default: '4' }, height: { type: 'string', default: '900' },
  detail: { type: 'boolean', default: false }, 'expanded-list': { type: 'boolean', default: false }, profile: { type: 'boolean', default: false }, paragraphs: { type: 'string', default: '40' },
} });
if (!args.release || !args.out) throw new Error('--release and --out are required');
const release = resolve(args.release), out = resolve(args.out);
mkdirSync(out, { recursive: true });
const original = createOriginal({ ...profiles.perf, seed: 'synthetic-v1' });
const root = join(out, 'workspace');
copyWorkspace(original.root, root);
const child = spawn(process.execPath, [join(release, 'apps/backend/dist/backend.js'), '--workspace', root, 'workspace', 'serve', '--port', '0'], {
  env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('ALPACAWORK_'))), stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
child.stdout.on('data', bytes => { log += bytes; }); child.stderr.on('data', bytes => { log += bytes; });
let browser: Browser | undefined;
const expiry = setTimeout(() => { child.kill('SIGTERM'); void browser?.close(); process.exitCode = 3; }, 15 * 60_000);
const results: unknown[] = [];
const save = () => {
  writeFileSync(join(out, 'server.log'), log);
  writeFileSync(join(out, 'results.json'), JSON.stringify({ release, source: 'common synthetic perf', fixture: { key: original.key, counts: original.counts },
    capturedAt: new Date().toISOString(), browser: browser?.version(), width: 390, height: Number(args.height), throttle: Number(args.throttle), expandedList: args['expanded-list'], profile: args.profile, paragraphs: Number(args.paragraphs), results }, null, 2));
};
// A paired runner gates each complete operation, so the other page does no preparation during its measurement.
const gate = async (phase: 'ready' | 'done', name: string) => {
  if (!process.send) return;
  await new Promise<void>((resolve, reject) => {
    const disconnected = () => { process.off('message', message); reject(new Error('Paired runner disconnected')); };
    const message = (value: unknown) => {
      process.off('disconnect', disconnected);
      value === (phase === 'ready' ? 'go' : 'advance') ? resolve() : reject(new Error('Unexpected paired instruction'));
    };
    process.once('message', message); process.once('disconnect', disconnected);
    process.send!({ phase, name });
  });
};
const disconnected = () => { child.kill('SIGTERM'); void browser?.close(); process.exitCode = 3; };
process.once('disconnect', disconnected);
try {
  browser = await chromium.launch();
  let url = '';
  const deadline = Date.now() + 60_000;
  while (!(url = /http:\/\/[\w.:]+/.exec(log)?.[0] ?? '')) {
    if (child.exitCode !== null || Date.now() > deadline) throw new Error(`Serve not ready: ${log}`);
    await new Promise(done => setTimeout(done, 50));
  }
  // Initial server reconciliation is outside the operation windows.
  let calm = Date.now();
  const calmDeadline = calm + 60_000;
  while (Date.now() - calm < 5000) {
    const asked = Date.now();
    await fetch(url + '/api/task/view?task=T2').then(reply => reply.text());
    if (Date.now() - asked > 300) calm = Date.now();
    if (Date.now() > calmDeadline) throw new Error('Server did not settle');
    await new Promise(done => setTimeout(done, 100));
  }
  const context = await browser.newContext({ viewport: { width: 390, height: Number(args.height) }, hasTouch: true, isMobile: true,
    locale: 'en-US', timezoneId: 'Asia/Tokyo', serviceWorkers: 'block' });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const conversation = { id: 'interaction-latency', nextLaunch: { agent: 'claude', values: {} }, busy: false, earlier: null, resets: [], context: null, autoReset: { tokens: 200_000, percent: 50 },
    turns: Array.from({ length: 40 }, (_, i) => ({ id: `turn-${i}`, at: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString(),
      ask: `Measured request ${i} about T2 and T3`, attachments: [], status: 'succeeded', waiting: false, seen: true, error: null, result: null,
      answer: Array.from({ length: i === 39 ? Number(args.paragraphs) : 2 }, (_, n) => `### Result ${n}\nT2 continues after T3. **Check** the report and its result.\n\n- First point\n- Second point\n`).join(''),
      answeredAt: new Date(Date.UTC(2026, 9, 1, 0, i, 30)).toISOString() })) };
  await page.route('**/api/coordinator', async route => { const reply = await route.fetch(); await route.fulfill({ response: reply, json: { ...await reply.json(), conversation } }); });

  await page.addInitScript(() => {
    const state = (window as any).interaction = { armed: false, start: 0, received: 0, done: 0, last: 0, frames: [] as number[],
      animations: [] as Animation[], loaf: [] as { start: number; duration: number; blocking: number }[], commits: 0, quiet: 0, scrolled: 0, gesture: false, expect: '', previousTask: undefined as string | undefined, collected: false, endProbe: null as unknown };
    const start = (event: Event) => { if (state.armed && !state.start) { state.start = event.timeStamp; state.received = performance.now();
      const target = event.target instanceof Element ? event.target : null;
      (state as any).input = { type: event.type, tag: target?.tagName, grip: !!target?.closest('[data-task-sheet-grab]'), content: !!target?.closest('[data-reader-content]') };
    } };
    document.addEventListener('touchend', event => { if (state.armed && state.start) (state as any).releaseMs = event.timeStamp; }, true);
    document.addEventListener('pointerdown', start, true); document.addEventListener('keydown', start, true); document.addEventListener('wheel', start, true);
    const rect = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function () {
      if (state.armed && state.start && !state.done && this.matches('li[data-row]')) (state as any).rowReads = ((state as any).rowReads ?? 0) + 1;
      return rect.call(this);
    };
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (...values: Parameters<typeof animate>) {
      const motion = animate.apply(this, values);
      if (state.armed) state.animations.push(motion);
      return motion;
    };
    const finite = (motion: Animation) => motion.effect?.getComputedTiming().iterations !== Infinity;
    const captureCSS = (event: Event) => {
      if (state.armed && event.target instanceof Element)
        for (const animation of event.target.getAnimations())
          if (finite(animation) && !state.animations.includes(animation)) state.animations.push(animation);
    };
    document.addEventListener('animationstart', captureCSS, true);
    document.addEventListener('transitionrun', captureCSS, true);
    const frame = (at: number) => {
      if (state.armed && state.start && !state.done) {
        if (state.last) state.frames.push(at - state.last);
        const scrolling = document.querySelector('[data-coordinator-panel] [data-card-scroll]')?.scrollTop ?? 0;
        const moved = scrolling !== state.scrolled; state.scrolled = scrolling;
        const target = state.expect === 'input-open' ? !!document.querySelector('[data-one-input]')
          : state.expect === 'input-close' ? !document.querySelector('[data-one-input]')
          : state.expect === 'chat-open' ? !!document.querySelector('[data-coordinator-panel]')
          : state.expect === 'chat-close' ? !document.querySelector('[data-coordinator-panel]')
          : state.expect === 'history-open' ? !document.querySelector('[data-earlier]') && document.querySelectorAll('[data-coordinator-message]').length === 40
          : state.expect === 'task-switch' ? document.querySelector('[data-reader-task-id]')?.textContent !== state.previousTask && !!document.querySelector('[data-history-ready="true"]')
          : state.expect === 'detail-open' ? !!document.querySelector('[data-reader-content]') && !!document.querySelector('[data-history-ready="true"]')
          : state.expect === 'detail-close' ? !document.querySelector('[data-reader-content]')
          : state.expect === 'detail-resize' ? !!document.querySelector('[data-sheet]:not([data-sheet-held])')
          : true;
        // animationstart fires after a CSS delay. Inventory once when the target DOM first exists,
        // so delayed rise animations cannot be missed by the quiet-frame completion check.
        if (target && !state.collected) {
          state.collected = true;
          for (const animation of document.getAnimations())
            if (finite(animation) && !state.animations.includes(animation)) state.animations.push(animation);
        }
        const active = state.gesture || state.expect === 'scroll' && moved || state.animations.some((animation: Animation) =>
          (animation.pending || animation.playState === 'running') && finite(animation));
        state.quiet = !active && target ? state.quiet + 1 : 0;
        if (state.quiet >= 3 && at - state.start >= 80) {
          state.done = at;
          state.endProbe = { rafAt: at, observedNow: performance.now(), animations: state.animations.map((a: Animation) => ({
            state: a.playState, pending: a.pending, currentTime: a.currentTime, startTime: a.startTime, timelineTime: a.timeline?.currentTime,
          })) };
        }
      }
      state.last = at;
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    new PerformanceObserver(list => { for (const entry of list.getEntries() as any[]) state.loaf.push({ start: entry.startTime, duration: entry.duration, blocking: entry.blockingDuration }); })
      .observe({ type: 'long-animation-frame', buffered: false });
    Object.defineProperty(window, '__REACT_DEVTOOLS_GLOBAL_HOOK__', { value: { renderers: new Map(), supportsFiber: true, isDisabled: false, checkDCE() {},
      inject() { return 1; }, onCommitFiberRoot() { state.commits++; }, onCommitFiberUnmount() {}, onPostCommitFiberRoot() {}, onScheduleFiberRoot() {} } });
  });
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: Number(args.throttle) });
  const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(row => [row.name, row.value]));
  await page.goto(url + (args.detail ? '/?agent=1' : '/?agent=1&task=T2'));
  await page.locator('[data-read]').first().waitFor();
  await page.waitForTimeout(1500);
  if (args['expanded-list']) {
    for (const more of await page.locator('[data-group-more] button').all()) await more.click();
    const done = page.locator('[data-section=done] button');
    if (await done.count()) await done.click();
    await page.waitForTimeout(1500);
  }
  const measure = async (name: string, expect: string, action: () => Promise<unknown>) => {
    await gate('ready', name);
    await page.waitForTimeout(300);
    const before = await metrics();
    await page.evaluate(expect => Object.assign((window as any).interaction, { armed: true, start: 0, received: 0, done: 0, frames: [], loaf: [], commits: 0, quiet: 0, collected: false, endProbe: null, gesture: false, releaseMs: 0, rowReads: 0, gestureFrom: null, input: null, scrolled: 0, previousTask: document.querySelector('[data-reader-task-id]')?.textContent, expect, animations: document.getAnimations().filter(a => a.effect?.getComputedTiming().iterations !== Infinity) }), expect);
    if (args.profile) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 500 }); await cdp.send('Profiler.start'); }
    await action();
    await page.waitForFunction(() => (window as any).interaction.done > 0);
    const after = await metrics();
    await page.waitForTimeout(100); // Let the observer deliver the last frame; done time is already fixed.
    const observation = await page.evaluate(() => {
      const p = (window as any).interaction; p.armed = false;
      return { elapsedMs: p.endProbe.observedNow - p.start, input: p.input, gestureFrom: p.gestureFrom, gestureTo: (() => { const el = document.querySelector('[data-sheet] aside[data-reader-mode=sheet]')?.parentElement; if (!el) return null; const rect = el.getBoundingClientRect(); return { top: rect.top, height: rect.height, scrollTop: el.querySelector('[data-reader-content]')?.scrollTop }; })(), releaseMs: p.releaseMs, releaseToEndMs: p.releaseMs ? p.endProbe.observedNow - p.releaseMs : undefined, inputDelayMs: p.received - p.start, startMs: p.start, doneMs: p.done, endProbe: p.endProbe, frames: p.frames, rowReads: p.rowReads, commits: p.commits, priorFrameMs: p.frames[0],
        task: document.querySelector('[data-reader-task-id]')?.textContent, messages: document.querySelectorAll('[data-coordinator-message]').length,
        leadingLoaf: p.loaf.filter((entry: any) => entry.start < p.start && entry.start + entry.duration >= p.start),
        loaf: p.loaf.filter((entry: any) => entry.start + entry.duration >= p.start && entry.start <= p.done),
        animations: p.animations.map((a: Animation) => ({ duration: a.effect?.getTiming().duration, timing: a.effect?.getTiming(), frames: (a.effect as KeyframeEffect)?.getKeyframes(), state: a.playState })) };
    });
    if (name.includes('detail-body-') && (!observation.input?.content || observation.input?.grip)) throw new Error('Native press did not reach the reading content');
    if (expect === 'detail-resize' && (!observation.gestureTo || !observation.gestureFrom || Math.abs(observation.gestureFrom.height - observation.gestureTo.height) < 40)) throw new Error('Gesture did not resize the sheet');
    if (args.profile) { const profile = await cdp.send('Profiler.stop'); writeFileSync(join(out, name + '.cpuprofile'), JSON.stringify(profile.profile)); await cdp.send('Profiler.disable'); }
    const delta = (key: string) => ((after[key] ?? 0) - (before[key] ?? 0)) * 1000;
    const row = { name, hostLoad: loadavg(), ...observation, frameMaxMs: Math.max(0, ...observation.frames), lateFrames: observation.frames.filter((n: number) => n > 25).length,
      missedFrames: observation.frames.reduce((n: number, ms: number) => n + Math.max(0, Math.round(ms / 16.67) - 1), 0),
      blockingMs: observation.loaf.reduce((n: number, entry: any) => n + entry.blocking, 0),
      scriptMs: delta('ScriptDuration'), layoutMs: delta('LayoutDuration'), styleMs: delta('RecalcStyleDuration'), errors: [...errors] };
    results.push(row); save(); console.log(name, Math.round(row.elapsedMs), 'ms', row.lateFrames, 'late', Math.round(row.frameMaxMs), 'max');
    await gate('done', name);
  };
  const tap = async (where: Locator) => { const box = await where.boundingBox(); if (!box) throw new Error('Missing tap target'); if (box.y + box.height / 2 < 0 || box.y + box.height / 2 >= Number(args.height)) throw new Error('Tap target outside viewport'); await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2); };
  if (args.detail) {
    const row = page.locator('[data-read]').first();
    const task = await row.getAttribute('data-read');
    const live = page.locator('[data-sheet]').filter({ has: page.locator('aside[data-reader-mode=sheet]') });
    const resetShare = () => page.evaluate(() => {
      localStorage.setItem('alpacawork.sheetHeight', String(2 / 3));
      dispatchEvent(new StorageEvent('storage', { key: 'alpacawork.sheetHeight' }));
    });
    const reopen = async () => { await resetShare(); await tap(row); await page.waitForTimeout(900); };
    const close = () => tap(live.locator('[data-reader-frame-buttons] button:last-child'));
    const pull = async (part: 'handle' | 'body', close: boolean) => {
      const box = await live.boundingBox(); if (!box) throw new Error('No live sheet');
      const area = part === 'handle' ? await live.locator('[data-task-sheet-grip]').boundingBox() : await live.locator('[data-reader-content]').boundingBox();
      if (!area) throw new Error('No gesture target');
      const x = part === 'handle' ? area.x + area.width / 2 : area.x + area.width - 8;
      const y = part === 'handle' ? area.y + area.height / 2 : await live.evaluate(el => {
        const content = el.querySelector('[data-reader-content]')!, header = el.querySelector('[data-reader-header]')!, title = el.querySelector('[data-head-title]');
        return Math.max(content.getBoundingClientRect().top, header.getBoundingClientRect().bottom, title?.getBoundingClientRect().bottom ?? 0) + 16;
      });
      const hit = await page.evaluate(({ x, y }) => { const at = document.elementFromPoint(x, y); return { content: !!at?.closest('[data-reader-content]'), grip: !!at?.closest('[data-task-sheet-grab]') }; }, { x, y });
      if (part === 'body' && (!hit.content || hit.grip)) throw new Error('Body point is covered by a grip or header');
      const travel = close ? Math.min(500, Number(args.height) - y - 8) : 100;
      await page.evaluate(box => { Object.assign((window as any).interaction, { gesture: true, gestureFrom: { top: box.y, height: box.height, scrollTop: document.querySelector('[data-reader-content]')?.scrollTop } }); }, box);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      for (let n = 1; n <= 8; n++) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + travel * n / 8 }] });
        await page.waitForTimeout(30);
      }
      if (!close) await page.waitForTimeout(180);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await page.evaluate(() => { const p = (window as any).interaction; p.gesture = false; });
    };
    await measure('warm-detail-open', 'detail-open', () => tap(row));
    await measure('warm-detail-close', 'detail-close', close);
    for (let i = 0; i < Number(args.rounds); i++) {
      await resetShare();
      await measure(`detail-open-${i}`, 'detail-open', () => tap(row));
      if (await live.locator('[data-reader-task-id]').textContent() !== task) throw new Error('Wrong task');
      await page.screenshot({ path: join(out, `detail-open-${i}.png`) });
      await measure(`detail-close-button-${i}`, 'detail-close', close);
      await reopen();
      await measure(`detail-close-back-${i}`, 'detail-close', async () => { await page.evaluate(() => { const p = (window as any).interaction; p.start = performance.now(); p.received = p.start; p.input = { type: 'browser-history-command' }; }); await page.goBack(); });
      for (const part of ['handle', 'body'] as const) {
        await reopen();
        await measure(`detail-${part}-resize-${i}`, 'detail-resize', () => pull(part, false));
        await page.screenshot({ path: join(out, `detail-${part}-resize-${i}.png`) });
        await measure(`detail-${part}-close-${i}`, 'detail-close', () => pull(part, true));
      }
    }
  } else {
  // Warm the conversation/catalog outside the measured repeat windows.
  await measure('warm-chat-open', 'chat-open', () => tap(page.locator('[data-coordinator-expand]').first()));
  await measure('warm-chat-close', 'chat-close', () => foldChat(page, tap));
  await page.waitForTimeout(500); await page.keyboard.press('Escape'); await page.waitForTimeout(500);
  await measure('warm-input-open', 'input-open', () => tap(page.locator('[data-coordinator-write]')));
  await measure('warm-input-close', 'input-close', () => page.keyboard.press('Escape'));
  for (let i = 0; i < Number(args.rounds); i++) {
    await measure(`input-open-${i}`, 'input-open', () => tap(page.locator('[data-coordinator-write]')));
    await measure(`input-close-${i}`, 'input-close', () => page.keyboard.press('Escape'));
    await measure(`chat-open-${i}`, 'chat-open', () => tap(page.locator('[data-coordinator-expand]').first()));
    await page.screenshot({ path: join(out, `opened-${i}.png`) });
    await page.locator('[data-earlier] button').scrollIntoViewIfNeeded();
    await measure(`history-open-${i}`, 'history-open', () => tap(page.locator('[data-earlier] button')));
    await page.screenshot({ path: join(out, `history-${i}.png`) });
    const scroll = page.locator('[data-coordinator-panel] [data-card-scroll]');
    await scroll.evaluate(el => { el.scrollTop = 0; });
    await page.waitForTimeout(300);
    const from = await scroll.evaluate(el => el.scrollTop);
    const box = await scroll.boundingBox(); if (!box) throw new Error('No conversation scroll area');
    await measure(`chat-scroll-${i}`, 'scroll', async () => {
      await page.evaluate(() => { (window as any).interaction.gesture = true; });
      const x = box.x + box.width / 2, y = box.y + box.height * 0.8;
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      for (let n = 1; n <= 8; n++) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - Math.min(240, box.height * 0.55) * n / 8 }] });
        await page.waitForTimeout(20);
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await page.evaluate(() => { (window as any).interaction.gesture = false; });
    });
    if (Math.abs(await scroll.evaluate(el => el.scrollTop) - from) < 20) throw new Error('Gesture did not scroll');
    await page.screenshot({ path: join(out, `open-${i}.png`) });
    await measure(`chat-close-${i}`, 'chat-close', () => foldChat(page, tap));
    await measure(`input-fold-${i}`, 'input-close', () => page.keyboard.press('Escape'));
  }
  await page.screenshot({ path: join(out, 'folded.png') });
  const next = page.locator('[data-list-next]');
  if (!await next.isEnabled()) throw new Error('Fixture has no next task');
  for (let i = 0; i < Number(args.rounds); i++) {
    await measure(`task-next-${i}`, 'task-switch', () => tap(next));
    await measure(`task-previous-${i}`, 'task-switch', () => tap(page.locator('[data-list-previous]')));
  }
  }
  if (errors.length) throw new Error('Browser errors: ' + errors.join('; '));
  await context.close();
} finally {
  process.off('disconnect', disconnected);
  clearTimeout(expiry); await browser?.close();
  if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); }
  save(); removeWorkspace(root);
  if (process.connected) process.disconnect();
}
