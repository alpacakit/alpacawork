import { fixtureAgentSetting, installAgentStub } from '../tests/helpers/agent-stub.ts';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { writeFixtureConfig } from './fixture-writes.ts';
import { test, expect, open, openCoordinator, settleMotion, writeCoordinator } from './fixtures.ts';
import { readyCoordinator, foldConversation } from './coordinator-fixture.ts';
import { markCentreGap } from './mark-centre.ts';

test.use({ isolated: true, fixedTime: false });
for (const phone of [false]) test(`observed work reaches folded and open conversation without rereading it (${phone ? 'phone' : 'pc'})`, async ({ page, runtime }, info) => {
  test.setTimeout(120_000);
  if (phone) await page.setViewportSize({ width: 390, height: 844 });
  else await page.setViewportSize({ width: 1440, height: 1000 });
  const agent = new URL('../tests/fixtures/fake-work-agent.mjs', import.meta.url).pathname;
  const existing = parse(readFileSync(join(runtime.root, 'config.yaml'), 'utf8'));
  installAgentStub(runtime.root, 'claude', [process.execPath, agent]);
  const setting = fixtureAgentSetting('claude');
  setting.params.model = ['opus', 'sonnet']; setting.params.effort = ['medium', 'high'];
  writeFixtureConfig(runtime.root, stringify({ ...existing, agents: { fake: setting, ...existing.agents } }));
  let reads = 0;
  page.on('request', request => { if (request.method() === 'GET' && new URL(request.url()).pathname === '/api/coordinator') reads++; });
  await open(page, runtime);
  await writeCoordinator(page);
  // The work shown is the send's own; the background warm-up it would otherwise wait behind has its own lifetime.
  await readyCoordinator(page, runtime);
  await page.keyboard.insertText('Show the observed work');
  await page.locator('[data-ask-send]').click();
  const pill = page.locator('[data-coordinator-pill]');
  await expect(pill).toContainText('New task');
  const first = await (await page.request.get(runtime.origin + '/api/coordinator')).json();
  // Native screenshots finish finite transitions and pause ambient pulse for the capture only.
  await page.screenshot({ path: info.outputPath('work-folded.png'), animations: 'disabled' });
  const box = (await pill.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(phone ? 390 : 1440);
  await openCoordinator(page);
  // Open, the step itself is read as it was run on the work line, the seconds at its end, without the rounded name.
  const steps = page.locator('[data-coordinator-turn=running] [data-working-steps]');
  await expect(steps).toContainText('alpacawork task new --title test');
  await expect(steps.locator('[data-work-seconds]')).toHaveText(/^\d+s$/);
  // The mark stands level with the words beside it.
  expect(await markCentreGap(steps.locator('[data-work-line]'))).toBeLessThanOrEqual(1);
  await page.screenshot({ path: info.outputPath('work-open.png'), animations: 'disabled' });
  await page.locator('[data-coordinator-turn=running] [data-exchange-toggle]').click();
  await expect(page.locator('[data-exchange-outcome]')).toContainText('New task');
  await page.locator('[data-coordinator-turn=running] [data-exchange-toggle]').click();
  // Opening the conversation intentionally refreshes it; measure only subsequent stdout-only changes.
  const beforeReads = reads;
  const gate = (stage: string) => writeFileSync(join(runtime.root, `work-${stage}`), '');
  gate('end');
  gate('unknown');
  await expect.poll(async () => {
    const { RunStore } = await import('@alpacawork/runs');
    const store = new RunStore(runtime.root, { busyTimeoutMs: 1000 }, true);
    try {
      const run = store.coordinatorRuns(first.conversation.id).filter(run => run.state === 'running').at(-1);
      const activity = run ? JSON.parse(readFileSync(join(store.folder(run.id), 'activity.json'), 'utf8')) : null;
      return activity?.doing ? { tool: activity.doing.toolName, command: activity.doing.command } : null;
    } finally { store.close(); }
  }).toEqual({ tool: 'Bash', command: null });
  // A command without the agent's words shows its own start, a `cd` and all, however it goes on.
  await expect(steps).toContainText('cd /tmp && \\');
  // A press lists every step so far, read from the Run's output, and another folds them back to the one line.
  const listed = page.locator('[data-coordinator-turn=running] [data-run-steps=open] [data-run-step]');
  await steps.click();
  await expect(steps).toHaveAttribute('aria-expanded', 'true');
  await expect(steps).toContainText('2 steps so far');
  await expect(listed).toHaveCount(2);
  // Opened, it reads in full, the fallback on its next line too.
  await listed.nth(1).locator('button').click();
  await expect(listed.nth(1).locator('[data-run-step-input]')).toContainText('echo alpacawork task new || echo failed');
  await steps.click();
  await expect(listed).toHaveCount(0);
  const ended = await (await page.request.get(runtime.origin + '/api/coordinator')).json();
  expect(ended.revision).toBe(first.revision);
  expect(reads).toBe(beforeReads);
  gate('update');
  await expect(steps).toContainText('alpacawork task update --task T1 --title changed');
  expect(reads).toBe(beforeReads);
  await foldConversation(page);
  await expect(pill).toContainText('Task update');
  // A resumed/new subscription receives current work with the index; it needs no separate stream or polling.
  await page.reload();
  await expect(pill).toContainText('Task update');
  gate('finish');
  await expect(pill).toContainText('Finished checking the work display');
  await page.screenshot({ path: info.outputPath('work-finished.png'), animations: 'disabled' });
  const evidence = process.env.COORDINATOR_WORK_EVIDENCE;
  if (evidence) {
    const { copyFileSync } = await import('node:fs');
    mkdirSync(evidence, { recursive: true });
    for (const name of ['work-folded', 'work-open', 'work-finished'])
      copyFileSync(info.outputPath(`${name}.png`), join(evidence, `${phone ? 'phone' : 'pc'}-${name}.png`));
  }
});

/** A long answer's turn at work, its last step under way, in the open conversation at PC width; `finish` ends it. */
async function longWork(page: import('@playwright/test').Page, runtime: { root: string; origin: string }) {
  await page.setViewportSize({ width: 1440, height: 900 });
  const agent = new URL('../tests/fixtures/fake-work-agent.mjs', import.meta.url).pathname;
  const existing = parse(readFileSync(join(runtime.root, 'config.yaml'), 'utf8'));
  installAgentStub(runtime.root, 'claude', [process.execPath, agent]);
  const setting = fixtureAgentSetting('claude');
  setting.params.model = ['opus']; setting.params.effort = ['medium'];
  writeFixtureConfig(runtime.root, stringify({ ...existing, agents: { fake: setting, ...existing.agents } }));
  await open(page, runtime);
  await writeCoordinator(page);
  await readyCoordinator(page, runtime);
  await page.keyboard.insertText('Answer at length');
  await page.locator('[data-ask-send]').click();
  await openCoordinator(page);
  const gate = (stage: string) => writeFileSync(join(runtime.root, `work-${stage}`), '');
  for (const stage of ['end', 'unknown', 'update']) gate(stage);
  const running = page.locator('[data-coordinator-turn=running]');
  await expect(running.locator('[data-working-steps]')).toContainText('alpacawork task update');
  return { running, area: page.locator('[data-coordinator-panel] [data-card-scroll]'), finish: () => gate('finish') };
}
/** The person's own move by `delta` over the conversation. */
async function wheel(page: import('@playwright/test').Page, area: import('@playwright/test').Locator, delta: number) {
  const box = (await area.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, delta);
}

test('a finished turn keeps its work until its answer comes, and a long answer is read from its start', async ({ page, runtime }) => {
  test.setTimeout(120_000);
  const { area, finish } = await longWork(page, runtime);
  // Following the end, every frame from here until the answer: the turn still running says what it did.
  // Followed by the person's own move to the end, as one who waits for the answer does.
  await wheel(page, area, 2000);
  await expect.poll(() => area.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThan(2);
  await page.evaluate(() => {
    const area = document.querySelector<HTMLElement>('[data-coordinator-panel] [data-card-scroll]')!;
    const seen = { bare: 0, done: false };
    (window as unknown as { seen: typeof seen }).seen = seen;
    const frame = () => {
      const turn = area.querySelector('[data-coordinator-turn=running]');
      if (turn && !turn.querySelector('[data-working-steps]')) seen.bare++;
      if (turn || !area.querySelector('[data-ask-answer]')) requestAnimationFrame(frame); else seen.done = true;
    };
    requestAnimationFrame(frame);
  });
  // The answer is read a moment after the Run's work has ended, as over a slower connection.
  await page.route(url => url.pathname === '/api/coordinator', async route => { await new Promise(done => setTimeout(done, 300)); await route.continue(); });
  finish();
  await expect.poll(() => page.evaluate(() => (window as unknown as { seen: { done: boolean } }).seen.done)).toBe(true);
  expect(await page.evaluate(() => (window as unknown as { seen: { bare: number } }).seen.bare), 'no frame without its work').toBe(0);
  await settleMotion(page, page.locator('[data-coordinator-panel]'), true);
  // The answer came in longer than the conversation: what it answers and its start stay in sight, its end below.
  const place = await page.evaluate(() => {
    const area = document.querySelector<HTMLElement>('[data-coordinator-panel] [data-card-scroll]')!, box = area.getBoundingClientRect();
    const said = [...area.querySelectorAll('[data-sent-message]')].at(-1)!.getBoundingClientRect();
    const first = area.querySelector('[data-ask-answer] p')!.getBoundingClientRect();
    return { said: said.top >= box.top, start: first.bottom <= box.bottom, end: area.scrollHeight - area.clientHeight - area.scrollTop > 48 };
  });
  expect(place).toEqual({ said: true, start: true, end: true });
  // Read 150px above the end of what is below it, that shrinks by more and grows back (the browser holds the reading at
  // the shrunken end meanwhile): the same words are read where they were, not taken for the person's own move.
  const resize = (height: number) => page.evaluate(height => {
    const thread = document.querySelector('[data-coordinator-panel] [data-coordinator-turn]:last-child')!;
    let room = thread.querySelector<HTMLElement>('[data-test-room]');
    if (!room) { room = document.createElement('div'); room.setAttribute('data-test-room', ''); thread.appendChild(room); }
    room.style.height = `${height}px`;
  }, height);
  const settled = () => settleMotion(page, page.locator('[data-coordinator-panel]'), true);
  await resize(300); await settled();
  await wheel(page, area, 3000);
  await expect.poll(() => area.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThan(2);
  await wheel(page, area, -150); await settled();
  const read = () => page.evaluate(() => {
    const area = document.querySelector<HTMLElement>('[data-coordinator-panel] [data-card-scroll]')!;
    const top = area.getBoundingClientRect().top + 60;
    const line = [...area.querySelectorAll('[data-ask-answer] p')].find(p => p.getBoundingClientRect().bottom > top)!;
    return { words: line.textContent, at: Math.round(line.getBoundingClientRect().top) };
  });
  const before = await read();
  await resize(0); await settled();
  await resize(300); await settled();
  expect(await read(), 'read where it was').toEqual(before);
});

test('an opened log, a step opened in it and the focus there stay as they are when the answer comes', async ({ page, runtime }) => {
  test.setTimeout(120_000);
  const { running, finish } = await longWork(page, runtime);
  await running.locator('[data-working-steps]').click();
  const step = running.locator('[data-run-step] button').first();
  await step.focus();
  await page.keyboard.press('Enter');
  await expect(running.locator('[data-run-step-open] [data-run-step-input]')).toBeVisible();
  const turn = page.locator('[data-coordinator-message]').filter({ has: page.locator('[data-run-steps=open]') });
  finish();
  await expect(turn.locator('[data-ask-answer]')).toBeVisible();
  await expect(turn.locator('[data-answer-steps] > button[aria-expanded=true]')).toBeVisible();
  await expect(turn.locator('[data-run-step-open] [data-run-step-input]')).toBeVisible();
  expect(await turn.locator('[data-run-step] button').first().evaluate(button => button === document.activeElement), 'the focus stays').toBe(true);
  // The work has ended: nothing in it is left at work.
  await expect(turn.locator('[data-run-step=running]')).toHaveCount(0);
  await expect(turn.locator('[data-work-mark]')).toHaveCount(0);
});
