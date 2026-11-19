import { fixtureAgentSetting, installAgentStub } from '../tests/helpers/agent-stub.ts';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { stringify } from 'yaml';
import { test as base, expect, open, openCoordinator, keepShot } from './fixtures.ts';
import { writeFixtureConfig } from './fixture-writes.ts';
import { start } from './server.ts';

/**
 * Whether a chosen skill can be used is read from the real catalog, the one a coordinator turn finds from its own
 * folder, while the coordinator is at work on another message. Only the last test narrows one agent's answer.
 */
const fakeAgent = new URL('../tests/fixtures/fake-coordinator-input.mjs', import.meta.url).pathname;
function configure(root: string) {
  // The catalog sees a normal native Claude launch; the executable is confined to this test root.
  installAgentStub(root, 'claude', [process.execPath, fakeAgent, '--fixture-native']);
  // Each saved agent is its own value. Reusing an object emits YAML aliases, which
  // the product deliberately refuses when loading settings.
  writeFixtureConfig(root, stringify({ agents: { fake: fixtureAgentSetting('claude'), second: fixtureAgentSetting('claude') } }, { lineWidth: 0 }));
  skill(root, 'keep');
  skill(root, 'other');
}
const folder = (root: string, name: string) => join(root, '.claude', 'skills', name);
function skill(root: string, name: string, description = `${name} does its work`) {
  mkdirSync(folder(root, name), { recursive: true });
  writeFileSync(join(folder(root, name), 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\nBody.\n`);
}

/** The gate a first message waits on; the fixture opens it when the test ends. */
const HOLD = 'hold-released';
function agentGone(root: string) {
  const started = join(root, 'agent-started');
  if (!existsSync(started)) return true;
  try { process.kill(Number(readFileSync(started, 'utf8')), 0); return false; } catch { return true; }
}

const test = base.extend({ runtime: async ({}, use) => {
  // The machine's own skills and settings are not this test's: serve's agents get an empty personal folder of their own.
  const config = mkdtempSync(join(tmpdir(), 'skill-standing-config-')), before = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = config;
  try {
    const runtime = await start(undefined, configure);
    try { await use(runtime); } finally {
      // A coordinator held at work is let go, or it would outlive this workspace.
      writeFileSync(join(runtime.root, HOLD), '');
      await expect.poll(() => agentGone(runtime.root), { timeout: 10_000 }).toBe(true);
      await runtime.stop();
    }
  } finally {
    if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = before;
    rmSync(config, { recursive: true, force: true });
  }
} });
test.use({ isolated: true });

const field = (page: Page) => page.locator('[data-coordinator-card] [data-one-input]');
const chip = (page: Page) => page.locator('[data-one-input-area] [data-label=skill]');
const toast = (page: Page) => page.locator('[data-toast]');
const send = (page: Page) => page.locator('[data-coordinator-card] [data-ask-send]').click();
/** What went to the coordinator, without the open Task's label a message starts with. */
const messages = (page: Page) => {
  const posted: string[] = [];
  page.on('response', response => { const request = response.request(); if (response.ok() && request.method() === 'POST' && request.url().endsWith('/api/coordinator/messages')) posted.push(JSON.parse(request.postData()!).text.replace(/^T\d+（[^）]*）\s*/, '').replace(/\s+/g, ' ')); });
  return posted;
};
async function ready(page: Page, runtime: Parameters<typeof open>[1], query = '?agent=1') {
  await open(page, runtime, query);
  await openCoordinator(page);
  await expect(field(page)).toHaveAttribute('contenteditable', 'true');
}
/** A first message the coordinator works on until the test ends, as in the screen the person reported. */
async function coordinatorAtWork(page: Page, root: string) {
  await field(page).click();
  const hold = `hold:${join(root, HOLD)}`;
  await page.keyboard.insertText(hold);
  // Agent startup can precede the HTTP response. Finish setup before a later
  // response observer starts measuring messages sent by the test itself.
  const [accepted] = await Promise.all([
    page.waitForResponse(response => response.request().method() === 'POST'
      && response.url().endsWith('/api/coordinator/messages')
      && response.request().postDataJSON().text.endsWith(hold)),
    send(page),
  ]);
  expect(accepted.ok()).toBe(true);
  await expect.poll(() => existsSync(join(root, 'agent-started')), { timeout: 20_000 }).toBe(true);
  await expect(page.locator('[data-coordinator-card] [data-ask-send]')).toBeVisible();
}
const option = (page: Page, name: string) => page.getByRole('listbox').getByRole('option', { name: new RegExp(`^/?\\s*${name}\\b`) });
async function choose(page: Page, name: string, words: string) {
  await field(page).click();
  await page.keyboard.insertText('/');
  await option(page, name).click();
  await expect(chip(page)).toContainText(name);
  await page.keyboard.insertText(words);
}

test('a chosen skill still goes to the coordinator at work when another skill is deleted, or the skill itself is edited', async ({ page, runtime }) => {
  // A child Task open beside it, as in the screen the person reported.
  await ready(page, runtime, '?task=T111&agent=1');
  await coordinatorAtWork(page, runtime.root);
  const posted = messages(page);

  await choose(page, 'keep', ' first words');
  rmSync(folder(runtime.root, 'other'), { recursive: true });
  await send(page);
  await expect.poll(() => posted).toEqual(['/keep first words']);
  await expect(chip(page)).toHaveCount(0);

  await choose(page, 'keep', ' second words');
  skill(runtime.root, 'keep', 'Edited while it was chosen');
  await send(page);
  await expect.poll(() => posted).toEqual(['/keep first words', '/keep second words']);
  await expect(toast(page)).toHaveCount(0);
  await keepShot(page, 'skill-sent-to-working-coordinator');
});

test('a skill that is really gone is refused with its words kept, and goes once it is back', async ({ page, runtime }) => {
  await ready(page, runtime);
  await coordinatorAtWork(page, runtime.root);
  const posted = messages(page);
  await choose(page, 'keep', ' words to keep');
  rmSync(folder(runtime.root, 'keep'), { recursive: true });
  await send(page);
  await expect(toast(page)).toContainText('Choose again from the skills this agent can use');
  expect(posted).toEqual([]);
  await expect(field(page)).toContainText('words to keep');
  await expect(chip(page)).toContainText('keep');
  // The refusal's own read is what the input now knows: the chip says so, the list no longer offers the skill.
  await expect(chip(page).locator('[title]')).toHaveAttribute('title', 'Choose again from the skills this agent can use');
  await keepShot(page, 'skill-really-gone');
  await field(page).click();
  await page.keyboard.press('End');
  await page.keyboard.insertText(' /');
  await expect(option(page, 'other')).toBeVisible();
  await expect(option(page, 'keep')).toHaveCount(0);
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');

  skill(runtime.root, 'keep');
  await send(page);
  await expect.poll(() => posted).toEqual(['/keep words to keep']);
});
