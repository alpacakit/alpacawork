import { seedTask } from './fixture/tasks.ts';
import { placeResponsible } from './fixture/responsible.ts';
import { expect, open, test } from "./fixtures.ts";
import { patchTask } from "./fixture/task-state.ts";
import { decideValues } from '../tests/helpers/task-values.ts';

test.use({ isolated: true });

// The list owns classification; retained questions remain readable after the run fails. It has no width of its own, and the phone's sheet is the tighter place.
for (const width of [1440]) test(`a failed question keeps the question mark, word and actions at ${width}px`, async ({ page, runtime }) => {
  const { seedQuestion } = await import('./fixture/task-state.ts');
  const asking = await placeResponsible(page.request, runtime.origin, seedTask(runtime.root, 'P1', 'Failed work with a user question'));
  const failed = await placeResponsible(page.request, runtime.origin, seedTask(runtime.root, 'P1', 'Failed work without a question'));
  const baseline = await (await page.request.get(`${runtime.origin}/api/workspace/live`)).json();
  patchTask(runtime.root, asking.id, { state: 'doing', values: decideValues(['Keep the unanswered question', ['Keep Continue', 'Keep the work'], ['Stop Pause', 'Pause the work']]) });
  const question = seedQuestion(runtime.root, asking.id, { to: 'user', title: 'Keep the unanswered question' });
  for (const id of [asking.id, failed.id]) patchTask(runtime.root, id, { state: 'error',
    logs: [{ id: crypto.randomUUID(), kind: 'linked', at: new Date().toISOString(), title: null, description: null,
      actor: { kind: 'human' }, fromState: 'doing', toState: 'error' }] });
  await page.setViewportSize({ width, height: 900 });
  await open(page, runtime, '?agent=1');
  await expect(page.locator(`[data-section="review"] + ol [data-row="${asking.id}"]`)).toBeVisible();
  await expect(page.locator(`[data-section="error"] + ol [data-row="${asking.id}"]`)).toHaveCount(0);
  await expect(page.locator(`[data-section="error"] + ol [data-row="${failed.id}"]`)).toBeVisible();
  await expect(page.locator(`[data-section="review"] + ol [data-row="${failed.id}"]`)).toHaveCount(0);
  const askedRow = page.locator(`[data-row="${asking.id}"]`);
  await expect(askedRow.locator('[data-icon="question"]')).toHaveClass(/text-turn/);
  await expect(askedRow.locator('[data-icon="error"]')).toHaveCount(0);
  await expect(askedRow.locator('[data-row-kind]')).toHaveCount(0);
  const index = await (await page.request.get(`${runtime.origin}/api/workspace/live`)).json();
  expect(index.counts.home.root.error).toBe(baseline.counts.home.root.error + 1);
  expect(index.counts.home.root.review).toBe(baseline.counts.home.root.review + 1);
  expect(index.home.find((row: { taskId: string }) => row.taskId === asking.id)?.section).toBe('review');
  expect(index.home.find((row: { taskId: string }) => row.taskId === failed.id)?.section).toBe('error');
  const { keepShot } = await import('./fixtures.ts');
  await keepShot(page, `your-turn-error-${width}`);
  await page.locator(`[data-read="${asking.id}"]`).click();
  const reader = page.getByRole('complementary');
  await expect(reader.getByText('Keep the unanswered question', { exact: true }).first()).toBeVisible();
  // The question stays the user's turn, yet the failure is still said under the title with its continue and Stop actions.
  const failure = reader.locator('[data-turn-reason="failed"]');
  await expect(failure).toBeVisible();
  await expect(failure.locator('[data-turn-action]')).toHaveText(['Continue with the same AI', 'Continue with another AI', 'Stop']);
  const detail = await (await page.request.get(`${runtime.origin}/api/task/view?task=${asking.id}`)).json();
  expect(detail.questions.some((item: { id: string }) => item.id === question)).toBe(true);
  await keepShot(page, `your-turn-question-${width}`);
});
