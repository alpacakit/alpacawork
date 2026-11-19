/** A reader approval keeps its Request identity after a later message is taken into the same coordinator Run. */
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, open, openCoordinator } from './fixtures.ts';
import { commandPost } from './command-post.ts';
import { configureInputCoordinator } from './coordinator-fixture.ts';
import { coordinatorMessage, coordinatorCompleted } from './coordinator-completion.ts';
import { placeResponsible } from './fixture/responsible.ts';
import { seedReview } from './fixture/task-state.ts';
import { SAMPLE_PROJECT } from './fixture/sample.ts';
import { readTaskLog } from './task-history.ts';

test.use({ isolated: true, viewport: { width: 1440, height: 900 } });

test('A approval after B is taken confirms A, keeps B empty and shows no false missing-operation notice', async ({ page, runtime }) => {
  test.setTimeout(90_000);
  configureInputCoordinator(runtime.root);
  writeFileSync(join(runtime.root, 'approve-after-joined'), '');
  const post = async (path: string, data: object) => {
    const response = await commandPost(page.request, runtime.origin + '/api/' + path, { data });
    expect(response.ok(), await response.text()).toBe(true); return response.json();
  };
  const made = (await post('task/new', { parent: SAMPLE_PROJECT.id, title: 'Approval keeps original Request' })).task;
  const task = await placeResponsible(page.request, runtime.origin, made, 'fake');
  const aboutRun = seedReview(runtime.root, task.id, { title: 'Please review', description: 'Confirm the fixed result' });
  await open(page, runtime, `?task=${task.id}`);
  const approvalRequest = coordinatorMessage(page);
  await expect(page.locator('[data-task-done]')).toBeEnabled();
  const current = await (await page.request.get(runtime.origin + '/api/task/get?task=' + task.id)).json();
  await openCoordinator(page);
  await page.locator('[data-one-input]').fill('confirm-review:' + JSON.stringify({ task: task.id, aboutRun, expectedTaskHash: current.task.hash, expectedPlacementRevision: current.agents.find((agent: any) => agent.active && agent.responsible).revision }));
  await page.locator('[data-ask-send]').click();
  const a = await approvalRequest, inputA = a.postDataJSON();
  expect(inputA.intent).toBeUndefined();
  await expect.poll(() => existsSync(join(runtime.root, 'approval-waiting'))).toBe(true);
  try {
    if (!await page.locator('[data-coordinator-panel]').isVisible()) await openCoordinator(page);
    const input = page.locator('[data-coordinator-card] [data-one-input]');
    await expect(input).toHaveAttribute('contenteditable', 'true');
    await input.fill('B is ordinary conversation and requests no task change.');
    const laterRequest = coordinatorMessage(page);
    await page.locator('[data-coordinator-card] [data-ask-send]').click();
    const b = await laterRequest, inputB = b.postDataJSON();
    expect(inputB.intent ?? null).toBeNull();
    const conversation = async () => (await (await page.request.get(runtime.origin + '/api/coordinator')).json()).conversation;
    await expect.poll(async () => (await conversation()).turns.find((turn: { id: string }) => turn.id === inputB.id)?.status).toBe('queued');
    // With the conversation open, B waits as its own message at the end with its own Send now.
    await page.locator(`[data-coordinator-panel] [data-coordinator-waiting="${inputB.id}"] [data-coordinator-send-now]`).click();
    await expect.poll(async () => (await conversation()).turns.find((turn: { id: string }) => turn.id === inputB.id)?.status).toBe('joined');
    writeFileSync(join(runtime.root, 'approval-release'), '');
    const finishedA = await coordinatorCompleted(page, runtime, a);
    expect(JSON.parse(finishedA.answer!).approval).toMatchObject({ sourceRequest: inputA.id, code: 0, output: { task: { state: 'done' } } });
    expect(finishedA.result?.writes).toEqual([expect.objectContaining({ task: task.id, kind: 'review_approved', runId: aboutRun })]);
    expect(finishedA.result?.refused).toEqual([]);
    const finishedB = (await conversation()).turns.find((turn: { id: string }) => turn.id === inputB.id);
    expect(finishedB.status).toBe('joined'); expect(finishedB.into).toBe(inputA.id);
    expect(finishedB.result).toEqual({ writes: [], refused: [] });
    const approved = (await readTaskLog(runtime.origin, task.id)).find(entry => entry.kind === 'review_approved');
    expect(approved?.actor).toMatchObject({ kind: 'main', message: inputA.id });
    await expect(page.locator('[data-coordinator-message="' + inputA.id + '"]')).toHaveAttribute('data-coordinator-turn', 'succeeded');
    await expect(page.locator('[data-toast]')).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath('approval-after-joined.png') });
  } finally { writeFileSync(join(runtime.root, 'approval-release'), ''); }
});
