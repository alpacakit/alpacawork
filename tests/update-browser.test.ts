/** Real settings, confirmation and retry against the synthetic managed installation and loopback npm. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { chromium, expect } from '@playwright/test';
import { managedUpdateFixture } from './helpers/managed-update.ts';
import { simpleUpdateCandidate } from './helpers/simple-update-candidate.ts';

test('browser confirms after a manual skill edit, retries the same operation and reaches the updated release', { skip: process.platform !== 'linux' && 'GNU tar --transform and a linux-x64-glibc fixture image', timeout: 600000 }, async t => {
  const f = await managedUpdateFixture(t), candidate = await simpleUpdateCandidate(t, f);
  // An unused older release and an obsolete/unpublished DB group must be collected by the real target controller.
  const obsoleteSource='e'.repeat(40),obsolete=join(f.releases,obsoleteSource),oldBackup=join(f.releases,'backups','obsolete');
  cpSync(f.release,obsolete,{recursive:true});writeFileSync(join(obsolete,'SOURCE'),obsoleteSource+'\n');
  mkdirSync(oldBackup,{recursive:true});writeFileSync(join(oldBackup,'control.sqlite'),'synthetic unpublished acquisition');
  mkdirSync(join(f.releases,'.release-metadata'));const provenance=join(f.releases,'.release-metadata',obsoleteSource+'.json');writeFileSync(provenance,'{}');
  await f.start();
  const settings = await f.call('/api/settings/get');
  assert.equal((await f.call('/api/settings/set', { key: 'language', value: 'en',
    expectedRevision: settings.body.revision, timeZone: 'Asia/Tokyo' }, { 'X-Alpacawork-Op-Id': randomUUID() })).status, 200);
  const status = await f.call('/api/update/status');
  const origin = new URL(status.url).origin;
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Tokyo', serviceWorkers: 'block' });
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    return /^https?:$/.test(url.protocol) && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      ? route.abort('blockedbyclient') : route.continue();
  });
  await context.tracing.start({ screenshots: true, snapshots: true });
  const page = await context.newPage();
  try {
    await page.goto(origin + '/?agent=1');
    await expect(page.locator('[data-update-mark="available"]')).toBeVisible({ timeout: 30000 });
    await page.getByRole('button', { name: /^Settings — .+ is available$/ }).click();
    await page.locator('[data-update-action]').click();
    await expect(page.locator('[data-update-confirm]')).toBeVisible();
    await expect(page.locator('[data-update-overwrite]')).toContainText('The alpacawork skill');

    // This happens after the real review. It must not invalidate the one confirmation.
    const skill = join(f.skills, 'alpacawork', 'SKILL.md'), edited = 'Manual edit after opening the confirmation.\n';
    writeFileSync(skill, edited);
    candidate.failMetadata(true);
    const firstResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/update/confirm'
      && response.request().method() === 'POST');
    await page.locator('[data-update-submit]').click();
    const accepted = await firstResponse;
    assert.equal(accepted.status(), 200, await accepted.text());
    const confirmation = accepted.request().postDataJSON();
    await expect(page.locator('[data-update-confirm]')).toHaveCount(0);
    await expect(page.locator('[data-update-state]')).toContainText('Could not download', { timeout: 45000 });
    assert.equal(readFileSync(skill, 'utf8'), edited, 'failed acquisition has not placed skills');
    await f.awaitUpdateControllers(confirmation.opId);

    candidate.failMetadata(false);
    const retryResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/update/confirm'
      && response.request().method() === 'POST');
    await page.locator('[data-update-action]').click();
    const retried = await retryResponse;
    assert.equal(retried.status(), 200, await retried.text());
    assert.deepEqual(retried.request().postDataJSON(), confirmation, 'retry retains the original confirmation');
    await expect(page.locator('[data-update-confirm]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Reload', exact: true })).toBeVisible({ timeout: 240000 });
    assert.notEqual(readFileSync(skill, 'utf8'), edited, 'the confirmed update overwrote the edited managed skill');
    assert.equal((await f.call('/api/update/status')).body.kind, 'done');
    await f.awaitUpdateControllers(confirmation.opId);
    const journal=JSON.parse(readFileSync(join(f.releases,'switch.json'),'utf8'));
    assert.equal(journal.phase,'committed');assert(existsSync(journal.backup));
    assert.deepEqual(readdirSync(join(f.releases,'backups')),[confirmation.opId]);
    assert.equal(existsSync(oldBackup),false);assert.equal(existsSync(obsolete),false);assert.equal(existsSync(provenance),false);
    await context.tracing.stop();
  } catch (error) {
    const evidence = resolve('.local/test-failures', 'update-browser-' + randomUUID());
    mkdirSync(evidence, { recursive: true });
    await page.screenshot({ path: join(evidence, 'screen.png'), fullPage: true }).catch(() => {});
    await context.tracing.stop({ path: join(evidence, 'trace.zip') }).catch(() => {});
    writeFileSync(join(evidence, 'failure.txt'), String(error));
    throw error;
  } finally {
    await browser.close();
  }
});
