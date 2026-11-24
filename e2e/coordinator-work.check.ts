import { fixtureAgentSetting, installAgentStub } from '../tests/helpers/agent-stub.ts';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { writeFixtureConfig } from './fixture-writes.ts';
import { test, expect, open, openCoordinator, writeCoordinator } from './fixtures.ts';
import { readyCoordinator, foldConversation } from './coordinator-fixture.ts';

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
  // Open, the step itself is read as it was run, and the seconds go on under it without the rounded name.
  const steps = page.locator('[data-coordinator-turn=running] [data-working-steps]');
  await expect(steps).toContainText('alpacawork task new --title test');
  await expect(page.locator('[data-coordinator-turn=running] [data-ask-thinking]')).toHaveText(/^Working on it… \d+s$/);
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
  await expect(steps).toContainText('echo alpacawork task new');
  // A press opens the latest step with the one before it, and another folds it back to its one line.
  await steps.click();
  await expect(steps).toHaveAttribute('aria-expanded', 'true');
  await expect(steps.locator('[data-run-step]')).toHaveCount(2);
  await steps.click();
  await expect(steps.locator('[data-run-step]')).toHaveCount(1);
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
