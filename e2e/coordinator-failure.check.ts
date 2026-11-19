import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test as base, expect, open, openCoordinator } from './fixtures.ts';
import { configureCoordinator, revealReplies } from './coordinator-fixture.ts';
import { start } from './server.ts';
import { coordinatorSnapshotSchema } from '@alpacawork/contract/coordinator';

const test = base.extend({ runtime: async ({}, use) => {
  const runtime = await start(undefined, configureCoordinator);
  try { await use(runtime); } finally { await runtime.stop(); }
} });
test.use({ isolated: true, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

test('failed coordinator keeps weekly reset, redacted general details and fallback through reload and retry', async ({ page, runtime }, info) => {
  await open(page, runtime, '?agent=1'); await openCoordinator(page);
  const field = page.locator('[data-coordinator-card] [data-one-input]');
  const send = page.locator('[data-coordinator-card] [data-ask-send]');
  for (const [message, words] of [['fail-weekly', 'Nov 8, 8pm (Asia/Tokyo)'], ['fail-general', 'Service unavailable.'], ['fail-exit', 'The agent exited before finishing']] as const) {
    await field.fill(message); await send.click();
    const failed = page.locator('[data-coordinator-turn=failed]').filter({ hasText: message });
    await expect(failed).toContainText(words);
    const alert = failed.getByRole('alert');
    await expect(alert).not.toContainText('sk-syntheticSecret123456');
    if (message === 'fail-general') await expect(alert).toContainText('[redacted]');
    await alert.scrollIntoViewIfNeeded();
    expect(await alert.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`${message}.png`) });
    const snapshot = coordinatorSnapshotSchema.parse(await (await page.request.get(runtime.origin + '/api/coordinator')).json());
    const last = snapshot.conversation.turns.at(-1)!;
    expect(last.status).toBe('failed');
    if (message === 'fail-weekly') expect(last.failure).toEqual({ cause: 'weekly_limit', message: "You've hit your weekly limit · resets Nov 8, 8pm (Asia/Tokyo)" });
    if (message === 'fail-exit') expect(last.failure).toBeUndefined();
    // On reload the latest failure is shown; earlier unread failures can be opened together.
    await page.reload(); await openCoordinator(page); await revealReplies(page);
    await expect(page.locator('[data-coordinator-turn=failed]').last()).toContainText(words);
  }
  // Retry the general failure using its actual control after repairing only the synthetic agent.
  writeFileSync(join(runtime.root, '.alpacawork/coordinator/.failure-repaired'), '');
  const general = page.locator('[data-coordinator-turn=failed]').filter({ hasText: 'fail-general' });
  // Earlier exchanges fold together on reopening; open them through the ordinary UI.
  if (!await general.count()) {
    await page.locator('[data-earlier] button[aria-expanded]').click();
  }
  const toggle = general.locator('[data-exchange-toggle]');
  if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
  await general.getByRole('button', { name: 'Send again', exact: true }).click();
  await expect(page.locator('[data-coordinator-turn=succeeded]').last()).toContainText('fail-general');
  await page.reload(); await openCoordinator(page); await revealReplies(page);
  await expect(page.locator('[data-coordinator-turn=succeeded]').last()).toContainText('fail-general');
  await page.screenshot({ path: info.outputPath('retry-success.png') });
});
