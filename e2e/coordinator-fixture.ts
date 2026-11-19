import { fixtureAgentSetting, installAgentStub } from '../tests/helpers/agent-stub.ts';
import { coordinatorSnapshotSchema, coordinatorMessageInputSchema } from '@alpacawork/contract/coordinator';
import type { CoordinatorConversation } from '@alpacawork/contract/coordinator';
import type { Page, Route } from '@playwright/test';
import { expect } from '@playwright/test';
import type { Runtime } from './server.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { writeFixtureConfig } from './fixture-writes.ts';
const fake = new URL('../tests/fixtures/fake-coordinator-agent.mjs', import.meta.url).pathname;
export function configureCoordinator(root: string) {
  // Keep the Task profiles: real coordinator writes can admit work to their existing seats.
  const existing = parse(readFileSync(join(root, 'config.yaml'), 'utf8'));
  const path = installAgentStub(root, 'claude', [process.execPath, fake]);
  const setting = fixtureAgentSetting('claude');
  setting.params.model = ['opus', 'sonnet']; setting.params.effort = ['medium', 'high'];
  writeFixtureConfig(root, stringify({ ...existing, agents: { fake: setting, ...existing.agents } }, { lineWidth: 0 }));
  return path;
}

/** A coordinator that accepts live input, with receipt gates controlled by each isolated test. */
export function configureInputCoordinator(root: string) {
  const agent = new URL('../tests/fixtures/fake-coordinator-input.mjs', import.meta.url).pathname;
  installAgentStub(root, 'alpacawork-agent', [process.execPath, agent]);
  writeFixtureConfig(root, stringify({ agents: { fake: fixtureAgentSetting('codex') } }, { lineWidth: 0 }));
}
export const fakeCoordinatorArgv = [process.execPath, new URL('./fixture/fake-coordinator.mjs', import.meta.url).pathname];
/**
 * Registers the e2e coordinator (fixture/fake-coordinator.mjs), which carries out each press and answer through the
 * alpacawork CLI, as the workspace's first agent: the screen's conversation starts it for each message. Bound as a
 * real coordinator is, it uses the profile's start/resume. The agents already
 * configured stay, for the Tasks' Runs. Before serve starts it is a `start` preparation; after, serve writes it.
 */
export function startFakeCoordinator(root: string): void {
  const config: { agents?: Record<string, unknown> } = parse(readFileSync(join(root, 'config.yaml'), 'utf8'));
  installAgentStub(root, 'claude', fakeCoordinatorArgv);
  writeFixtureConfig(root, stringify({ ...config, agents: {
    'fake-coordinator': fixtureAgentSetting('claude'), ...config.agents,
  } }, { lineWidth: 0 }));
}

/** Answer/gesture checks start after the separate background warm-up, before their timed send.
 * Warm-input/queue checks deliberately do not use this preparation. */
export async function readyCoordinator(page: Page, runtime: Runtime) {
  const conversation = async (): Promise<CoordinatorConversation> => {
    const response = await page.request.get(runtime.origin + '/api/coordinator');
    expect(response.ok()).toBe(true);
    return coordinatorSnapshotSchema.parse(await response.json()).conversation;
  };
  const opening = await conversation();
  const warmed = await page.request.post(runtime.origin + '/api/coordinator/warm', {
    data: { conversationId: opening.id, agent: 'fake', selected: { model: 'opus', effort: 'medium' } },
  });
  expect(warmed.ok()).toBe(true);
  await expect.poll(async () => {
    const current = await conversation();
    return { id: current.id, agent: current.agent, preparing: current.warm === 'preparing' };
  }, { timeout: 20_000 }).toEqual({ id: opening.id, agent: 'fake', preparing: false });
}

/** The same real running/queued set must back every size comparison; warm-up is a separate lifetime. */
export async function expectCoordinatorQueue(page: Page, runtime: Runtime,
  expected: { conversationId: string; running: string; waiting: string[] }, expanded = false) {
  await expect.poll(async () => {
    const response = await page.request.get(runtime.origin + '/api/coordinator');
    expect(response.ok()).toBe(true);
    const conversation = coordinatorSnapshotSchema.parse(await response.json()).conversation;
    return { conversationId: conversation.id, preparing: conversation.warm === 'preparing',
      active: conversation.turns.filter(turn => ['running', 'queued', 'sending'].includes(turn.status))
        .map(({ id, status }) => ({ id, status })) };
  }).toEqual({ conversationId: expected.conversationId, preparing: false,
    active: [{ id: expected.running, status: 'running' }, ...expected.waiting.map(id => ({ id, status: 'queued' }))] });
  const queue = page.locator('[data-coordinator-queue-over]');
  const button = page.locator('[data-coordinator-queue-button]');
  await expect(button).toHaveText(`Waiting ${expected.waiting.length}`);
  await expect(button).toHaveAttribute('aria-expanded', String(expanded));
  await expect.poll(() => queue.locator('[data-coordinator-waiting]').evaluateAll(rows =>
    rows.map(row => row.getAttribute('data-coordinator-waiting')))).toEqual(expanded ? expected.waiting : []);
}

/** The POSTs of messages, their bodies, and a gate each waits on until released (none: they go at once). */
export async function holdCoordinatorPosts(page: Page) {
  const bodies: ReturnType<typeof coordinatorMessageInputSchema.parse>[] = [];
  let mode: 'pass' | 'before' | 'after' | 'refuse' | 'cut' = 'pass';
  let release!: () => void;
  let gate = Promise.resolve();
  await page.route('**/api/coordinator/messages', async (route: Route) => {
    bodies.push(coordinatorMessageInputSchema.parse(route.request().postDataJSON()));
    const now = mode, waiting = gate;
    const refuse = () => route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: { code: 'conflict', message: 'refused', retry: 'reread' } }) });
    // Held before serve: on release it goes, unless it is to be refused by then.
    if (now === 'before') { await waiting; await (mode === 'refuse' ? refuse() : route.continue()); }
    else if (now === 'after') { const response = await route.fetch(); await waiting; await route.fulfill({ response }); }
    else if (now === 'refuse') await refuse();
    else if (now === 'cut') await route.abort('internetdisconnected');
    else await route.continue();
  });
  return { bodies, set: (next: typeof mode) => { mode = next; gate = new Promise(resolve => { release = resolve; }); }, release: () => release(),
    refuseHeld: () => { const go = release; mode = 'refuse'; go(); } };
}

/** Hold real deliveries, then make serve refuse their conversation before admission. */
export async function holdRefusedCoordinatorPosts(page: Page, runtime: Runtime) {
  let refusing = true;
  const held: { input: ReturnType<typeof coordinatorMessageInputSchema.parse>; release: () => void }[] = [];
  const handling = new Set<Promise<void>>();
  const hold = async (request: Route) => {
    if (!refusing) return request.continue();
    const input = coordinatorMessageInputSchema.parse(request.request().postDataJSON());
    let release = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    held.push({ input, release });
    await gate;
    await request.continue({ postData: JSON.stringify({ ...input, conversationId: 'missing-conversation' }) });
  };
  // Each held request is continued by its own handler before the route goes: unrouting first leaves it to the page.
  const route = (request: Route) => { const handled = hold(request); handling.add(handled); return handled.finally(() => handling.delete(handled)); };
  await page.route('**/api/coordinator/messages', route);
  return {
    held,
    async refuse(index: number) {
      if (!Number.isSafeInteger(index) || index < 0) throw new Error(`Invalid held coordinator POST index: ${index}`);
      await expect.poll(() => held[index] !== undefined, {
        message: `Waiting for held coordinator POST ${index} before refusing admission`,
      }).toBe(true);
      const sent = held[index];
      if (!sent) throw new Error(`Expected held coordinator POST ${index} before refusing admission`);
      const response = page.waitForResponse(reply => new URL(reply.url()).pathname === '/api/coordinator/messages'
        && reply.request().postDataJSON().id === sent.input.id);
      sent.release();
      const refused = await response;
      expect(refused.status()).toBe(409);
      expect((await refused.json()).error.reason.kind).toBe('conversation_has_changed');
      const snapshot = await page.request.get(`${runtime.origin}/api/coordinator`);
      expect(snapshot.ok()).toBe(true);
      const { conversation } = coordinatorSnapshotSchema.parse(await snapshot.json());
      expect(conversation.turns.some(turn => turn.id === sent.input.id)).toBe(false);
      return sent.input;
    },
    pass: () => { refusing = false; },
    async dispose() {
      refusing = false;
      for (const sent of held) sent.release();
      await Promise.allSettled([...handling]);
      await page.unroute('**/api/coordinator/messages', route);
    },
  };
}

/** The latest exchange is shown on opening; older reply contents, already read, need their history row pressed.
 * These callers exercise reply contents; the exact folding and its message count are checked in coordinator-read-line.
 */
export async function revealReplies(page: Page) {
  const panel = page.locator('[data-coordinator-panel]');
  await expect(panel.locator('[data-coordinator-turn]').last()).toBeVisible();
  const row = panel.locator('[data-earlier=folded]');
  if (await row.count()) {
    await row.locator('button[aria-expanded]').click();
    await expect(panel.locator('[data-earlier]')).toHaveCount(0);
  }
}

/**
 * Folds the conversation if it is open, as a person would: its ⌄ (on a phone too, beside the place to hold);
 * where it has none, its head held and pulled down to the screen's foot, which lets it go whatever the speed
 * (sheetRelease). Folded already, nothing.
 */
export async function foldConversation(page: Page) {
  const fold = page.locator('[data-coordinator-panel] [data-coordinator-fold]');
  if (await fold.count()) { await fold.click(); return; }
  const sheet = page.locator('[data-coordinator-phone]');
  if (!await sheet.count()) return;
  const box = (await sheet.boundingBox())!, foot = page.viewportSize()!.height - 4;
  const x = box.x + box.width * 0.3, from = box.y + 10;
  const session = await page.context().newCDPSession(page);
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: from }] });
  for (let i = 1; i <= 8; i++) await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: from + (foot - from) * i / 8 }] });
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await session.detach();
  await expect(sheet).toHaveCount(0);
}
