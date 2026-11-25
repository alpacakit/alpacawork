import { commandPost } from './command-post.ts';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect, open } from './fixtures.ts';
import { configureCoordinator } from './coordinator-fixture.ts';
import { patchTask, seedQuestion, taskFolder } from './fixture/task-state.ts';
import { SAMPLE_PROJECT } from './fixture/sample.ts';
import type { Runtime } from './server.ts';
import type { TaskValues } from '@alpacawork/contract';

// Answer choices: a choice pressed in the detail panel is carried into the coordinator's input as its chip.
// Native chip Animations and the ordinary RAF observations share the real browser clock.
// Only cueFrames explicitly controls RAF for the existing flight deadline/width checks.
test.use({ isolated: true, fixedTime: false });
test.describe.configure({ timeout: 90_000 });
const chip = (page: Page, n: string) => page.locator(`[data-label-layer] [data-answer-n="${n}"] > *`);
const choice = (page: Page, q: number, n: number) => page.locator(`[data-question="${q}"]`).getByRole('button', { name: new RegExp(`Alt${n}`) });
/**
 * A Task the user asked for in the sample's project, whose responsible, at work, asks them its body's questions
 * (seedQuestion; a question keeps the state, so the Task is at work first), opened in the reader.
 */
async function begin(page: Page, runtime: Runtime, width = 1440, text?: TaskValues) {
  configureCoordinator(runtime.root);
  // The first question's shared text names a Task and a file of the Task's folder.
  const values = { decide: [
    { decide_kind: 'choose', decide_question: 'Which option', decide_choices: [{ decide_choice: 'Alt1 Send current input', decide_choice_detail: 'Send' },
      { decide_choice: 'Alt2 Decide later', decide_choice_detail: 'Hold it' }], decide_note: 'Related: T111 [Note](note.md)' },
    { decide_kind: 'choose', decide_question: 'Additional review', decide_choices: [{ decide_choice: 'Alt1 Proceed', decide_choice_detail: 'Select it' },
      { decide_choice: 'Alt2 Later', decide_choice_detail: 'Put on hold' }] }] };
  const made = await commandPost(page.request, runtime.origin + '/api/commands/task/new', { data: { parent: SAMPLE_PROJECT.id, title: 'Choice view', values: text ?? values } });
  expect(made.ok(), await made.text()).toBe(true);
  const task = (await made.json()).task as { id: string; hash: string };
  // The coordinator's config keeps only its own agent, so the responsible is placed with that profile.
  const placed = await commandPost(page.request, runtime.origin + '/api/commands/agent/assign', { data: { task: task.id, role: 'responsible', profile: 'fake', expectedTaskHash: task.hash } });
  expect(placed.ok(), await placed.text()).toBe(true);
  patchTask(runtime.root, task.id, { state: 'doing' });
  seedQuestion(runtime.root, task.id, { to: 'user', title: 'Please choose an option', description: 'Please choose.' });
  const folder = taskFolder(runtime.root, task.id);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'note.md'), '# Note\n');
  await page.setViewportSize({ width, height: 900 });
  await open(page, runtime, `?agent=1&task=${task.id}`);
  await expect(choice(page, 1, 1)).toBeVisible();
  return task.id;
}

async function clean(page: Page) {
  await expect(page.locator('[data-cue-copy], [data-cue-leaving], [data-answer-cue-hidden]')).toHaveCount(0);
  // Sending can remove the input between driver calls; inspect the currently mounted faces together.
  await expect.poll(() => page.locator('[data-label-layer] [data-answer-task] > *')
    .evaluateAll(faces => faces.every(face => getComputedStyle(face).opacity === '1'))).toBe(true);
}

/** A dismissed surface must release its decorations within two frames, rather than just finish its old flight. */
async function released(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect(await page.locator('[data-cue-copy], [data-cue-leaving], [data-answer-cue-hidden]').count()).toBe(0);
  await clean(page);
}

test('closing before the editor commits cannot resurrect a pending flight or hide its saved answer', async ({ page, runtime }) => {
  await begin(page, runtime);
  const close = await page.getByRole('button', { name: 'Close details', exact: true }).elementHandle();
  await choice(page, 1, 1).evaluate((button: HTMLElement, close) => { button.click(); (close as HTMLElement).click(); }, close);
  await released(page);
  await page.waitForTimeout(750);
  await clean(page);
  await expect(chip(page, '1')).toBeVisible();
});
