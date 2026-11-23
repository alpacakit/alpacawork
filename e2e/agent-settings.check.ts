import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import type { Page } from '@playwright/test';
import { writeFixtureConfig } from './fixture-writes.ts';
import { fixtureAgentSetting, installAgentStub } from '../tests/helpers/agent-stub.ts';
import { test, expect, open, openCoordinator } from './fixtures.ts';

// The agent is the claude adapter run through a local stub on the test's own PATH: it reports the --model it was given.
const fake = new URL('../tests/fixtures/fake-coordinator-agent.mjs', import.meta.url).pathname;
test.use({ isolated: true, viewport: { width: 1280, height: 720 } });

async function openAgent(page: Page) {
  await page.getByRole('button', { name: /^Settings/ }).click();
  await page.getByRole('tab', { name: 'Server', exact: true }).click();
  await page.locator('#server-agents > summary').click();
  await page.getByRole('button', { name: 'Expand fake' }).click();
  return page.locator('[data-agent-name="fake"]');
}
const save = (page: Page) => page.locator('[data-settings-foot]').getByRole('button', { name: 'Save', exact: true });
const saved = (page: Page) => expect(page.locator('[data-settings-foot]').getByRole('status')).toHaveText('Saved');
const savedAgent = (root: string) => parse(readFileSync(join(root, 'config.yaml'), 'utf8')).agents.fake;

test('a model added in the settings is kept, offered when asking, and given to the agent; restoring edited launch options asks first', async ({ page, runtime }) => {
  test.setTimeout(120_000);
  installAgentStub(runtime.root, 'claude', [process.execPath, fake]);
  writeFixtureConfig(runtime.root, stringify({ agents: { fake: fixtureAgentSetting('claude') } }, { lineWidth: 0 }));
  await open(page, runtime);

  // A model the adapter does not know is the person's to add: saved, and there after the screen is read again.
  let agent = await openAgent(page);
  const models = agent.getByRole('textbox', { name: 'Available values for model' });
  await models.fill(`${await models.inputValue()}, my-model`);
  await save(page).click();
  await saved(page);
  await page.reload();
  agent = await openAgent(page);
  await expect(agent.getByRole('textbox', { name: 'Available values for model' })).toHaveValue(/, my-model$/);
  // It is offered for the input's AI, and the launch carries it.
  await page.locator('[data-ai-stack="coordinator"]').getByLabel('Model in row 1').selectOption('my-model');
  await save(page).click();
  await saved(page);
  await page.keyboard.press('Escape');
  await openCoordinator(page);
  const card = page.locator('[data-coordinator-card], [data-coordinator-panel]');
  await expect(card.locator('[data-coordinator-ai]')).toContainText('my-model');
  await card.getByRole('textbox', { name: 'Message the coordinator' }).fill('Use the added model');
  await card.locator('[data-ask-send]').click();
  await expect(card.locator('[data-coordinator-turn]').last()).toHaveAttribute('data-coordinator-turn', 'succeeded');
  const answer = JSON.parse((await card.locator('[data-coordinator-turn]').last().locator('[data-ask-answer]').textContent())!);
  expect(answer.args[0]).toBe('my-model');

  // Edited launch options go back to the defaults only once the person confirms; cancelling keeps the edit.
  await page.reload();
  agent = await openAgent(page);
  await agent.getByRole('button', { name: 'Edit in advanced settings' }).click();
  const start = agent.getByRole('textbox', { name: 'New conversation' });
  await start.fill(`${await start.inputValue()} --verbose`);
  await save(page).click();
  await saved(page);
  expect(savedAgent(runtime.root).options.start).toMatch(/ --verbose$/);
  const ask = page.getByRole('dialog', { name: 'Restore default launch options for fake?' });
  await agent.getByRole('button', { name: 'Restore defaults' }).click();
  await ask.getByRole('button', { name: 'Cancel' }).click();
  await expect(start).toHaveValue(/ --verbose$/);
  await agent.getByRole('button', { name: 'Restore defaults' }).click();
  await ask.getByRole('button', { name: 'Restore defaults' }).click();
  await expect(agent.getByRole('button', { name: 'Edit in advanced settings' })).toBeVisible();
  await save(page).click();
  await saved(page);
  expect(savedAgent(runtime.root).options).toBeUndefined();
});
