/** An unassigned completed Task is a review the screen can approve through the coordinator's real CLI. */
import type { CoordinatorConversation, CoordinatorMessageInput } from '@alpacawork/contract/coordinator';
import { test, expect, settleMotion, openCoordinator } from './fixtures.ts';
import { commandPost } from './command-post.ts';
import { startFakeCoordinator } from './coordinator-fixture.ts';
import { patchTask } from './fixture/task-state.ts';
import { readTaskLog } from './task-history.ts';

test.use({ isolated: true, viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });
test.describe.configure({ timeout: 90_000 });

test('Done approves a Task snapshot with no responsible, Run target, or placement version', async ({ page, runtime }, info) => {
  startFakeCoordinator(runtime.root);
  const post = async (path: string, data: object) => {
    const response = await commandPost(page.request, runtime.origin + '/api/' + path, { data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const view = async (id: string) => (await (await page.request.get(runtime.origin + '/api/commands/task/get?task=' + id)).json());
  const { task: project } = await post('commands/task/new', { kind: 'project', color: '#39659b', parent: 'none', title: 'Historic result review' });
  const { task } = await post('commands/task/new', { parent: project.id, fromUser: true, title: 'Earlier review equivalent',
    values: { notes: 'The result was completed earlier. Please confirm it again.' } });
  // Isolated historical preparation only. The operation being checked below uses the public API.
  patchTask(runtime.root, task.id, { state: 'done', logs: [{ id: crypto.randomUUID(), kind: 'reported',
    at: new Date().toISOString(), title: 'Historical completion', description: null, actor: { kind: 'human' },
    fromState: 'todo', toState: 'done' }] });
  const before = await view(task.id);
  const waiting = await post('commands/task/report', { task: task.id, state: 'waiting', opId: crypto.randomUUID(), expectedTaskHash: before.task.hash });
  const shown = await view(task.id);
  expect(shown.reviewRun).toBeNull();
  expect(shown.questions).toEqual([]);
  const live = await (await page.request.get(runtime.origin + '/api/workspace/live')).json();
  expect(live.placements.filter((placement: { taskId: string }) => placement.taskId === task.id)).toEqual([]);
  expect(live.runs.filter((run: { taskId: string }) => run.taskId === task.id)).toEqual([]);
  expect(live.tasks.find((row: { id: string }) => row.id === task.id)?.ball).toMatchObject({ holder: 'user', reason: 'review', aboutRunId: null });
  await page.goto(runtime.origin + `/?agent=1&project=${project.id}&task=${task.id}`);
  const reader = page.locator('aside[data-reader-mode]');
  await expect(reader.locator('header [data-reader-task-id]')).toHaveText(task.id);
  await settleMotion(page);
  const done = page.locator('[data-task-done]');
  await expect(done).toBeEnabled();
  await page.screenshot({ path: info.outputPath('task-snapshot-review-waiting.png') });
  const sent: Record<string, any>[] = [], screenReports: string[] = [];
  page.on('request', request => {
    if (request.method() !== 'POST') return;
    const path = new URL(request.url()).pathname;
    if (path === '/api/commands/task/report') sent.push(request.postDataJSON());
    if (path === '/api/commands/task/report') screenReports.push(path);
  });
  await done.click();
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0]).toMatchObject({ state: 'done', task: task.id, expectedTaskHash: waiting.task.hash });
  expect(sent[0]).not.toHaveProperty('aboutRun');
  expect(sent[0]).not.toHaveProperty('expectedPlacementRevision');
  await expect.poll(async () => (await view(task.id)).task.state, { timeout: 30_000 }).toBe('done');
  const approved = (await readTaskLog(runtime.origin, task.id)).find(entry => entry.kind === 'review_approved');
  expect(approved?.actor).toMatchObject({ kind: 'human' });
  expect(approved?.runId ?? null).toBeNull();
  expect(screenReports).toHaveLength(1);
  await page.screenshot({ path: info.outputPath('task-snapshot-review-approved.png') });
});


test('a written revision request sends a Task snapshot back without inventing the reviewed Run', async ({ page, runtime }, info) => {
  startFakeCoordinator(runtime.root);
  const post = async (path: string, data: object) => {
    const response = await commandPost(page.request, runtime.origin + '/api/' + path, { data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const view = async (id: string) => {
    const response = await page.request.get(runtime.origin + '/api/commands/task/get?task=' + id + '&log=100&runs=10');
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const { task: project } = await post('commands/task/new', { kind: 'project', color: '#39659b', parent: 'none', title: 'Historic result revision' });
  const { task } = await post('commands/task/new', { parent: project.id, fromUser: true, title: 'Snapshot to revise',
    values: { notes: 'This completed result needs another edit.' } });
  patchTask(runtime.root, task.id, { state: 'done', logs: [{ id: crypto.randomUUID(), kind: 'reported',
    at: new Date().toISOString(), title: 'Historical completion', description: null, actor: { kind: 'human' },
    fromState: 'todo', toState: 'done' }] });
  const before = await view(task.id);
  const waiting = await post('commands/task/report', { task: task.id, state: 'waiting', opId: crypto.randomUUID(),
    expectedTaskHash: before.task.hash });
  await post('commands/agent/assign', { task: task.id, role: 'responsible', profile: 'codex', expectedTaskHash: waiting.task.hash });
  const shown = await view(task.id);
  expect(shown.reviewRun).toBeNull();
  expect(shown.questions).toEqual([]);
  expect(shown.runs).toEqual([]);
  const responsible = shown.agents.find((each: { active: boolean; responsible: boolean }) => each.active && each.responsible);
  expect(responsible).toBeDefined();
  await page.goto(runtime.origin + `/?agent=1&project=${project.id}&task=${task.id}`);
  await expect(page.locator('aside[data-reader-mode] header [data-reader-task-id]')).toHaveText(task.id);
  await openCoordinator(page);
  const field = page.locator('[data-one-input]');
  await expect(field).toHaveAttribute('contenteditable', 'true');
  const words = `Revise this result for ${task.id} by explaining the remaining limitation`;
  await field.fill(words);
  const sent: CoordinatorMessageInput[] = [];
  page.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/coordinator/messages')
      sent.push(request.postDataJSON());
  });
  await page.locator('[data-ask-send]').click();
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0]).toMatchObject({ text: words, tasks: [task.id] });
  expect(sent[0]!.intent ?? null).toBeNull();
  let answer: { command: string[]; ok: boolean; output: { outcome: { request: { runId: string } } } } | null = null;
  await expect.poll(async () => {
    const conversation = (await (await page.request.get(runtime.origin + '/api/coordinator')).json()).conversation as CoordinatorConversation;
    const turn = conversation.turns.find(each => each.id === sent[0]!.id);
    answer = turn?.answer ? JSON.parse(turn.answer) : null;
    return answer;
  }, { timeout: 30_000 }).toMatchObject({ ok: true, output: { outcome: { kind: 'request_accepted' } } });
  expect(answer!.command.slice(0, 2)).toEqual(['task', 'request']);
  expect(answer!.command).not.toContain('--about-run');
  expect(answer!.command).toContain(shown.task.hash);
  expect(answer!.command).toContain(String(responsible.revision));
  const runId = answer!.output.outcome.request.runId;
  await expect.poll(async () => {
    const latest = await view(task.id);
    return latest.runs.find((run: { id: string }) => run.id === runId)?.startedAt ?? null;
  }, { timeout: 30_000 }).not.toBeNull();
  const returned = (await readTaskLog(runtime.origin, task.id)).find(entry => entry.kind === 'review_sent_back');
  expect(returned?.actor).toMatchObject({ kind: 'main', quote: words });
  expect(returned?.runId ?? null).toBeNull();
  const latest = await view(task.id);
  expect(latest.runs).toHaveLength(1);
  expect(latest.runs[0]).toMatchObject({ id: runId, placementId: responsible.id });
  expect(latest.task.log.some((entry: { toState: string | null }) => entry.toState === 'doing')).toBe(true);
  await page.screenshot({ path: info.outputPath('task-snapshot-review-sent-back.png') });
});
