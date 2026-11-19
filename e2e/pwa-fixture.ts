/** A profile/context specialization of the canonical fixture, never a second server/runner. */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { test as base, expect, turnAutoSwipeOn } from './fixtures.ts';
import { startFakeCoordinator } from './coordinator-fixture.ts';
import { installedWorker } from './service-worker-lifecycle.ts';
import { applyPageClock } from './page-clock.ts';
import { failureJson, fixtureDeadline, withFixtureCleanup } from './fixture-cleanup.ts';
import { captureFailure } from './failure-evidence.ts';
import { recoveryStageMs } from './pwa-evidence-budget.ts';
export const test = base.extend({
  isolated: true, fixedTime: true, retainRuntime: false,
  runtimePrepare: async ({}, use) => { await use(startFakeCoordinator); },
  context: async ({ playwright, browserName, contextOptions, launchOptions, viewport, hasTouch, isMobile, locale, timezoneId, deviceScaleFactor, runtime, fixedTime }, use, info) => {
    if (browserName !== 'chromium') throw Error('The bounded PWA plan is Chromium only');
    const profile = info.outputPath('profile');
    mkdirSync(profile);
    const options = { ...launchOptions, ...contextOptions, viewport, hasTouch, isMobile, locale, timezoneId, deviceScaleFactor, serviceWorkers: 'allow' as const };
    let context = await playwright.chromium.launchPersistentContext(profile, options), generation = 0, tracing = false;
    const instrument = async () => {
      const log = (kind: string, data: unknown) => appendFileSync(info.outputPath('network-console.jsonl'), JSON.stringify({ at: Date.now(), generation, kind, data }) + '\n');
      context.on('request', request => log('request', { url: request.url(), method: request.method(), body: request.postData() }));
      context.on('response', response => log('response', { url: response.url(), status: response.status() }));
      context.on('requestfailed', request => log('requestfailed', { url: request.url(), failure: request.failure() }));
      context.on('console', message => log('console', { type: message.type(), text: message.text() }));
      context.on('weberror', error => log('weberror', String(error.error())));
      const browser = context.browser();
      if (browser) { const cdp = await browser.newBrowserCDPSession(); log('processes', await cdp.send('SystemInfo.getProcessInfo')); await cdp.detach(); }
    };
    await instrument();
    (context as any).activePwaPage = () => context.pages()[0];
    // Reopening retains this fixture's profile, trace and shutdown ownership, with a new browser process.
    (context as any).restartPwa = async (offline: boolean) => {
      if (tracing) { await context.tracing.stop({ path: info.outputPath(`trace-generation-${generation}.zip`) }); tracing = false; }
      await context.close(); generation++;
      context = await playwright.chromium.launchPersistentContext(profile, { ...options, offline });
      await instrument(); await context.tracing.start({ snapshots: true, sources: true }); tracing = true;
      const page = context.pages()[0] ?? await context.newPage(); await applyPageClock(page, fixedTime); return page;
    };
    await withFixtureCleanup(async () => {
      await context.tracing.start({ snapshots: true, sources: true });
      tracing = true;
      writeFileSync(info.outputPath('context.json'), JSON.stringify({ profile, origin: runtime.origin, traceOwner: 'pwa-fixture.context', serviceWorkers: 'allow' }));
      await use(context);
    }, [{ name: 'trace-stop', timeoutMs: recoveryStageMs.trace, run: async () => { if (tracing) await context.tracing.stop({ path: info.outputPath('trace.zip') }); } },
      { name: 'context-close', timeoutMs: recoveryStageMs.close, run: () => context.close() }], failures => {
      writeFileSync(info.outputPath('context-teardown.json'), JSON.stringify({ originalTestErrors: info.errors,
        failures: failures.map(each => ({ stage: each.stage, error: failureJson(each.error) })) }, null, 2));
    });
  },
  failureEvidence: async ({ page, context, runtime, captureScreenshots }, use, info) => {
    try { await use(); } finally {
      if (info.status !== info.expectedStatus) await fixtureDeadline(() => captureFailure((context as any).activePwaPage?.() ?? page, runtime, info, captureScreenshots), recoveryStageMs.capture);
    }
  },
  page: async ({ context, fixedTime, writeGraceMs, autoSwipe }, use) => {
    const page = context.pages()[0] ?? await context.newPage();
    if (autoSwipe) await turnAutoSwipeOn(page);
    await page.addInitScript(ms => { (window as Window & { __ALPACAWORK_WRITE_GRACE_MS__?: number }).__ALPACAWORK_WRITE_GRACE_MS__ = ms; }, writeGraceMs);
    await applyPageClock(page, fixedTime);
    await use(page);
  },
});
export { expect };
/** Observe the production registration and the production FORMAT14 control and slots. No IDB writes or fake hydration. */
export async function controlledPwa(page: Page) {
  await installedWorker(page); await page.reload();
  await expect.poll(() => page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    return { secure: isSecureContext, state: registration?.active?.state,
      script: navigator.serviceWorker.controller && new URL(navigator.serviceWorker.controller.scriptURL).pathname };
  }), { timeout: 20_000 }).toEqual({ secure: true, state: 'activated', script: '/sw.js' });
  const checkpoint = () => page.evaluate(async () => {
    const databases = await indexedDB.databases();
    if (!databases.some(db => db.name === 'alpacawork-read-checkpoint')) return null;
    return new Promise<{ format: number; queries: number; origin: string; root: string; savedAt: number; scopeCut: boolean } | null>((resolve, reject) => {
      const open = indexedDB.open('alpacawork-read-checkpoint');
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction(['control', 'slots'], 'readonly'), request = tx.objectStore('control').get('current'), slots = tx.objectStore('slots').getAll();
        tx.oncomplete = () => { const control = request.result; db.close(); resolve(control ? { format: control.format, queries: slots.result.length,
          origin: control.scope?.origin, root: control.scope?.root, savedAt: control.savedAt, scopeCut: control.cut } : null); };
        tx.onabort = () => { db.close(); reject(tx.error); };
      };
    });
  });
  await expect.poll(async () => { const saved = await checkpoint(); return saved?.format === 14 && saved.queries > 0 && saved.origin === new URL(page.url()).origin; },
    { timeout: 20_000 }).toBe(true);
  await test.info().attach('formal-pwa-ready', { contentType: 'application/json', body: JSON.stringify({
    controller: await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL), checkpoint: await checkpoint() }) });
}
