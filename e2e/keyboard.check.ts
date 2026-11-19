import { writeFixtureConfig } from './fixture-writes.ts';
import { fixtureAgentSetting, installAgentStub } from '../tests/helpers/agent-stub.ts';
import { stringify } from 'yaml';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Locator } from '@playwright/test';
import { test, expect, open, settleMotion, openCoordinator } from './fixtures.ts';
import { SAMPLE_NOW } from './fixture/sample.ts';

// Opening the coordinator card starts its conversation in the background: on a server of its own, with a fake agent.
test.use({ isolated: true });
const fake = new URL('../tests/fixtures/fake-coordinator-agent.mjs', import.meta.url).pathname;
const fakeCoordinator = (runtime: { root: string }) => {
  installAgentStub(runtime.root, 'claude', [process.execPath, fake]);
  const setting = fixtureAgentSetting('claude');
  setting.params.model = [];
  setting.params.effort = [];
  writeFixtureConfig(runtime.root, stringify({ agents: { fake: setting } }));
};

/** A phone (Android, 1080×2400 at 2.625) as the app sees it: the screen, then the room left over its keyboard. */
const PHONE = { width: 412, height: 846 }, OVER_KEYBOARD = 466;

test('on a phone the keyboard shrinks the page, and the input it is for sits right above it', async ({ browser, runtime }) => {
  const shots = process.env.ALPACAWORK_KEYBOARD_SHOTS;
  if (shots) mkdirSync(shots, { recursive: true });
  const context = await browser.newContext({ viewport: PHONE, hasTouch: true, isMobile: true, colorScheme: 'dark', deviceScaleFactor: shots ? 2.625 : 1 });
  fakeCoordinator(runtime);
  const page = await context.newPage();
  await page.clock.setFixedTime(new Date(SAMPLE_NOW));
  // The browser shrinks the page for it, rather than sliding the whole screen up to bring the input into sight.
  await page.goto(`${runtime.origin}/`);
  expect(await page.locator('meta[name=viewport]').getAttribute('content')).toContain('interactive-widget=resizes-content');
  const keyboard = async (input: Locator, shot: string) => {
    await page.setViewportSize(PHONE);
    const bottom = () => input.evaluate(el => el.closest('[data-one-input-area]')!.getBoundingClientRect().bottom);
    await expect.poll(bottom).toBeLessThanOrEqual(PHONE.height);
    await input.focus();
    // Before: the page at the screen's full height, as the browser kept it under the keyboard (it then slid the
    // screen up to bring the input to the middle of the room left; the picture is cut from this one at that slide).
    if (shots) {
      await settleMotion(page);
      const box = (await input.boundingBox())!;
      writeFileSync(join(shots, `${shot}-before.json`), JSON.stringify({ center: box.y + box.height / 2 }));
      await page.screenshot({ path: join(shots, `${shot}-before.png`) });
    }
    await page.setViewportSize({ width: PHONE.width, height: OVER_KEYBOARD });
    // Right above it: no room under the input but its frame's own edges.
    await expect.poll(bottom).toBeLessThanOrEqual(OVER_KEYBOARD);
    expect(OVER_KEYBOARD - await bottom()).toBeLessThan(48);
    if (shots) { await settleMotion(page); await page.screenshot({ path: join(shots, `${shot}.png`) }); }
  };
  await open(page, runtime);
  await openCoordinator(page);
  const card = page.locator('[data-coordinator-card]');
  await keyboard(card.getByRole('textbox', { name: 'Message the coordinator' }), 'coordinator');
  // Its top stays in sight.
  expect((await card.boundingBox())!.y).toBeGreaterThanOrEqual(0);
  await page.locator('[data-coordinator-panel]').getByRole('button', { name: 'Close the conversation', exact: true }).click();
  await open(page, runtime, '?task=T111');
  await openCoordinator(page);
  await keyboard(page.locator('[data-one-input]'), 'task-context');
  await context.close();
});
