import { writeFileSync } from 'node:fs';
import type { Page, Route } from '@playwright/test';
import { test as base, expect, open, openCoordinator, writeCoordinator, keepShot } from './fixtures.ts';
import { atTheTop } from './toast-position.ts';
import { configureCoordinator, foldConversation } from './coordinator-fixture.ts';
import { start } from './server.ts';
import { markCentreGap } from './mark-centre.ts';

// What is sent shows at once and the input is free at once; serve's snapshot settles it, whichever of the POST's
// answer and the event comes first; a refused send comes back, an unknown one is resent as it was.
const test = base.extend({ runtime: async ({}, use) => {
  const runtime = await start(undefined, configureCoordinator);
  try { await use(runtime); } finally { await runtime.stop(); }
} });
test.use({ isolated: true });

const field = (page: Page) => page.locator('[data-coordinator-card] [data-one-input]');
const thread = (page: Page) => page.locator('[data-coordinator-thread]');
/** The POSTs of messages, their bodies, and a gate each waits on until released (none: they go at once). */
function hold(page: Page) {
  const bodies: { id: string; text: string }[] = [];
  let mode: 'pass' | 'before' | 'after' | 'refuse' | 'cut' = 'pass';
  let release!: () => void;
  let gate = Promise.resolve();
  void page.route('**/api/coordinator/messages', async (route: Route) => {
    bodies.push(JSON.parse(route.request().postData()!));
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
/** The line under a sent message's words: its size, where it starts, and how far below the words it stands. */
const statusLine = (row: import('@playwright/test').Locator) => row.evaluate(item => {
  const said = item.querySelector('[data-sent-message]')!.getBoundingClientRect();
  const line = item.querySelector<HTMLElement>('[data-ask-thinking], [role=status]')!;
  // Its words, measured as text: a mark before them (the ring, the dot) may make its box taller than the words.
  const words = document.createTreeWalker(line, NodeFilter.SHOW_TEXT).nextNode()!, range = document.createRange();
  range.selectNodeContents(words);
  return { size: getComputedStyle(line).fontSize, left: Math.round(line.getBoundingClientRect().left),
    below: Math.round(range.getBoundingClientRect().top - said.bottom), height: Math.round(line.getBoundingClientRect().height) };
});
async function ready(page: Page, runtime: Parameters<typeof open>[1]) {
  await open(page, runtime, '?agent=1');
  await openCoordinator(page);
  await expect(field(page)).toHaveAttribute('contenteditable', 'true');
  await expect(page.locator('[data-coordinator-card]').getByRole('button', { name: 'Attach', exact: true })).toBeEnabled();
  // Each case starts from an idle coordinator conversation.
  await expect.poll(async () => {
    const { conversation } = await (await page.request.get(runtime.origin + '/api/coordinator')).json();
    return !!conversation && !conversation.busy;
  }, { timeout: 30000 }).toBe(true);
}

for (const phone of [false]) test.describe(phone ? 'phone' : 'pc', () => {
  if (phone) test.use({ viewport: { width: 412, height: 846 }, hasTouch: true, isMobile: true });

  // The outbox has no branch by device; a phone's press goes through the next case.
  if (!phone) test('sent words leave the input immediately; empty presses send once; the next submission queues', async ({ page, runtime }) => {
    const posts = hold(page);
    await ready(page, runtime);
    posts.set('before');
    await field(page).fill('Instruction shown first');
    const send = page.locator('[data-coordinator-card] [data-ask-send]');
    await send.click();
    // The retained original is hidden from the editor; only new words can form another submission.
    await expect(thread(page).locator('[data-coordinator-local=sending]')).toContainText('Instruction shown first');
    await expect(thread(page).locator('[data-coordinator-local=sending]')).toContainText('Sending…');
    // On its way it already shows the work's mark, where the work line will show it.
    await expect(thread(page).locator('[data-coordinator-local=sending] [data-coordinator-posting] [data-work-mark]')).toHaveCount(1);
    // The mark stands level with the words beside it.
    expect(await markCentreGap(thread(page).locator('[data-coordinator-local=sending] [data-coordinator-posting]'))).toBeLessThanOrEqual(1);
    // On its way nothing is offered to take back, and the place it is said stays one element up to its answer.
    const sending = thread(page).locator('[data-coordinator-local=sending]');
    await expect(sending.locator('[data-coordinator-withdraw]')).toHaveCount(0);
    const sent = await sending.getAttribute('data-coordinator-message');
    await sending.locator('[data-coordinator-reply]').evaluate(place => { (place as HTMLElement & { kept?: boolean }).kept = true; });
    await expect(thread(page).locator('[data-ask-thinking]')).toHaveCount(0);
    await expect(field(page)).toHaveText('');
    await expect(send).toBeDisabled();
    await field(page).press('Enter'); // Empty presses cannot create another submission.
    await field(page).pressSequentially('Next draft');
    await expect(send).toBeEnabled();
    await send.click();
    await expect(field(page)).toHaveText('');
    expect(posts.bodies).toHaveLength(1);
    posts.release();
    await expect(thread(page).locator('[data-coordinator-turn=succeeded]')).toHaveCount(2);
    expect(await thread(page).locator(`[data-coordinator-message="${sent}"] [data-coordinator-reply]`)
      .evaluate(place => (place as HTMLElement & { kept?: boolean }).kept)).toBe(true);
    await expect(thread(page).locator('[data-coordinator-local]')).toHaveCount(0);
    await expect(thread(page).getByText('Instruction shown first', { exact: true })).toHaveCount(1);
    await expect(field(page)).not.toContainText('Next draft');
    expect(posts.bodies).toHaveLength(2);
    expect(posts.bodies.map(each => each.text)).toEqual(['Instruction shown first', 'Next draft']);
    expect(posts.bodies[0]!.id).not.toBe(posts.bodies[1]!.id);
  });

  // Why a send did not go is the shared toast, as every other failure; nothing is written over the input.
  test(`a refused send is back in the input and its reason is the shared toast, not a line over the input${phone ? ' (phone)' : ''}`, async ({ page, runtime }) => {
    if (phone) await page.setViewportSize({ width: 390, height: 844 });
    const posts = hold(page);
    await ready(page, runtime);
    posts.set('refuse');
    await field(page).fill('Refused instruction');
    const send = page.locator('[data-coordinator-card] [data-ask-send]');
    if (phone) await send.tap(); else await send.click();
    await expect(field(page)).toContainText('Refused instruction');
    await page.waitForTimeout(600);
    await keepShot(page, `send-refused-${phone ? 'phone' : 'pc'}`);
    const toast = page.locator('[data-toast][data-kind=error]');
    await expect(toast).toHaveText(/Not sent \(the server refused it\)/);
    await expect(toast).toHaveCount(1);
    await expect(page.locator('[data-one-input-area] [role=alert]')).toHaveCount(0);
    await atTheTop(toast);
    // A second refusal takes the first one's place; a send that goes takes it away.
    if (phone) await send.tap(); else await send.click();
    await expect(field(page)).toContainText('Refused instruction');
    await expect(toast).toHaveCount(1);
    posts.set('pass');
    if (phone) await send.tap(); else await send.click();
    await expect(thread(page).locator('[data-coordinator-turn=succeeded]')).toHaveCount(1);
    await expect(toast).toHaveCount(0);
  });
});

test.describe('coordinator three-second grace',()=>{
  test.use({fixedTime:false,writeGraceMs:3000});
  test('a message waits in the pill and the existing sender wakes at three real seconds (390px)',async({page,runtime})=>{
    const width = 390;
    await page.setViewportSize({ width, height: 900 });
    const posts=hold(page);
    await ready(page,runtime);
    posts.set('before');
    await field(page).fill('Grace deadline message');
    const pressed=Date.now();
    await page.locator('[data-coordinator-card] [data-ask-send]').click();
    await expect(page.locator('[data-toast][data-kind="info"]')).toHaveCount(0);
    await expect(field(page)).toHaveText('');
    const waiting = thread(page).locator('[data-coordinator-local=waiting]');
    await expect(waiting.locator('[data-coordinator-cancel-unsent]')).toHaveText('Undo');
    await expect(waiting).toContainText('Sending soon');
    const pill = page.locator('[data-coordinator-pill]');
    await expect(pill).toContainText('Sending soon');
    await expect(pill).toHaveAttribute('data-coordinator-pill-state', 'waiting');
    await foldConversation(page);
    await expect(pill).toBeVisible();
    await expect(page.locator('[data-coordinator-panel]')).toHaveCount(0);
    await expect(page.locator('[data-still-copy], [data-grow-back]')).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath('grace-waiting.png') });
    await page.waitForTimeout(500);
    expect(posts.bodies).toHaveLength(0);
    await expect.poll(()=>posts.bodies.length,{timeout:7000}).toBe(1);
    expect(Date.now()-pressed).toBeGreaterThanOrEqual(2900);
    await expect(pill).toHaveText('Sending…');
    await page.screenshot({ path: test.info().outputPath('grace-sending.png') });
    await pill.click();
    await expect(thread(page).locator('[data-coordinator-local=sending]')).toContainText('Sending…');
    // On its way it already shows the work's mark, where the work line will show it.
    await expect(thread(page).locator('[data-coordinator-local=sending] [data-coordinator-posting] [data-work-mark]')).toHaveCount(1);
    posts.release();
    await expect(thread(page).locator('[data-coordinator-turn=succeeded]')).toHaveCount(1);
    expect(posts.bodies[0]!.text).toBe('Grace deadline message');
    await expect(field(page)).not.toContainText('Grace deadline message');
  });
  test('while working, sent words wait at the conversation end and cancellation returns them; a folded phone opens on the final waiting message', async ({ page, runtime }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await ready(page, runtime);
    const release = runtime.root + '/send-presentation-release';
    const snapshot = await (await page.request.get(runtime.origin + '/api/coordinator')).json();
    const first = crypto.randomUUID();
    await page.request.post(runtime.origin + '/api/coordinator/messages', { data: {
      conversationId: snapshot.conversation.id, id: first, text: 'wait:' + release, attachments: [],
    } });
    try {
      await expect(thread(page).locator('[data-coordinator-turn=running]')).toBeVisible();
      const send = page.locator('[data-ask-send]');
      await field(page).fill('Cancel during grace'); await send.click();
      await expect(field(page)).toHaveText('');
      const grace = thread(page).locator('[data-coordinator-local=waiting]');
      await expect(grace).toContainText('Sending soon');
      // A message's state changes in place — the same size, start and distance under its words as the work's own line.
      const working = await statusLine(thread(page).locator('[data-coordinator-turn=running]'));
      expect(await statusLine(grace)).toEqual(working);
      await grace.locator('[data-coordinator-cancel-unsent]').click();
      await expect(field(page)).toHaveText('Cancel during grace');
      await field(page).fill('Waiting behind current work'); await send.click();
      const waiting = thread(page).locator('[data-coordinator-waiting]').filter({ hasText: 'Waiting behind current work' });
      await expect(waiting).toContainText('Queued');
      // Waiting its turn, nothing moves: the still ring, not the work's moving mark, which comes once it is on its way.
      await expect(waiting.locator('[role=status] [data-waiting-mark]')).toHaveCount(1);
      await expect(waiting.locator('[data-work-mark]')).toHaveCount(0);
      expect(await statusLine(waiting)).toEqual(working);
      await expect(waiting.locator('[data-coordinator-send-now]')).toBeVisible();
      await expect(waiting.locator('[data-exchange-toggle]')).toHaveCount(0);
      await expect(page.locator('[data-coordinator-queue-button]')).toHaveCount(0);
      const gap = await waiting.evaluate(row => {
        const up = row.querySelector('[data-coordinator-send-now]')!.getBoundingClientRect();
        return row.querySelector('[data-coordinator-withdraw]')!.getBoundingClientRect().left - up.right;
      });
      expect(gap).toBeGreaterThanOrEqual(8);
      await waiting.locator('[data-coordinator-withdraw]').click();
      await expect(field(page)).toHaveText('Waiting behind current work');
      await expect(waiting).toHaveCount(0);
      await foldConversation(page);
      for (const words of ['Folded first waiting message', 'Folded final waiting message']) {
        if (!await field(page).isVisible()) await writeCoordinator(page);
        await field(page).fill(words); await send.click();
      }
      await expect(page.locator('[data-coordinator-queue-button]')).toHaveText('2 waiting');
      await page.locator('[data-coordinator-pill] [data-coordinator-expand], button[data-coordinator-pill]').click();
      const final = thread(page).locator('[data-coordinator-waiting]').filter({ hasText: 'Folded final waiting message' });
      await expect(final).toBeInViewport();
      await expect(final.locator('[data-coordinator-withdraw]')).toBeInViewport();
      await expect(page.locator('[data-coordinator-queue-button]')).toHaveCount(0);
      await page.screenshot({ path: test.info().outputPath('waiting-at-thread-end-phone.png') });
      // Sent now, it is on its way like any message: "Sending…" in the same line, with nothing left to take back.
      const line = final.locator('[data-coordinator-reply] > *').first();
      await line.evaluate(place => { (place as HTMLElement & { kept?: boolean }).kept = true; });
      await final.locator('[data-coordinator-send-now]').click();
      await expect(final.locator('[data-coordinator-reply]')).toContainText('Sending…');
      await expect(final.locator('[data-coordinator-reply] [data-work-mark]')).toHaveCount(1);
      await expect(final.locator('[data-waiting-mark]')).toHaveCount(0);
      await expect(final.locator('[data-coordinator-withdraw]')).toHaveCount(0);
      expect(await line.evaluate(place => (place as HTMLElement & { kept?: boolean }).kept)).toBe(true);
    } finally { writeFileSync(release, ''); }
  });
  test('inline undo returns the original beside newer input and announces no toast',async({page,runtime})=>{
    const posts=hold(page);
    await ready(page,runtime);
    await field(page).fill('Original cancelled message');
    await page.locator('[data-coordinator-card] [data-ask-send]').click();
    await field(page).fill('Newer words');
    await thread(page).locator('[data-coordinator-cancel-unsent]').click();
    await expect(field(page)).toContainText('Newer words');
    await expect(field(page)).toContainText('Original cancelled message');
    await expect(page.locator('[data-toast][data-kind="success"]')).toHaveCount(0);
    await expect(page.locator('[data-toast][data-kind="error"]')).toHaveCount(0);
    await expect(thread(page).locator('[data-coordinator-local=refused]')).toHaveCount(0);
    await page.waitForTimeout(3100);
    expect(posts.bodies).toHaveLength(0);
    await expect(field(page)).toContainText('Newer words');
  });
});

for (const edit of ['append'] as const) test(`a late admission consumes only the sent edition and leaves ${edit} draft words untouched`, async ({ page, runtime }) => {
  await ready(page, runtime);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const sent: { text: string }[] = [];
  await page.route('**/api/coordinator/messages', async route => {
    sent.push(route.request().postDataJSON()); await gate; await route.continue();
  });
  try {
    await field(page).fill('Original admission is delayed');
    await page.locator('[data-coordinator-card] [data-ask-send]').click();
    await expect.poll(() => sent.length).toBe(1);
    await expect(field(page)).toHaveText('');
    await field(page).press('End'); await page.keyboard.insertText('The next independent draft');
    release();
    await expect(thread(page).locator('[data-coordinator-turn=succeeded]')).toHaveCount(1);
    await expect(field(page)).toHaveText('The next independent draft');
    expect(sent.map(each => each.text)).toEqual(['Original admission is delayed']);
  } finally { release(); }
});

test.describe('pending admission', () => {
  // The caret's moves are ProseMirror's, which tells the browser's own resets from a person's by how long ago the focus
  // and the last press were: under a fixed clock that time never passes.
  test.use({ fixedTime: false });
for (const edit of ['replace', 'remove'] as const) test(`admission preserves Task context ${edit}d while the sent body was pending`, async ({ page, runtime }) => {
  await ready(page, runtime);
  await field(page).fill('');
  await field(page).pressSequentially('#T111');
  await page.getByRole('listbox').getByRole('option').first().click();
  const labels = page.locator('[data-coordinator-card] [data-label-layer] [data-label=task]');
  const original = (await labels.locator('.tabular-nums').textContent())!;
  let current: string | null = null;
  await page.keyboard.insertText(' First message.');
  const posts = hold(page); posts.set('before');
  try {
    await page.locator('[data-coordinator-card] [data-ask-send]').click();
    await expect.poll(() => posts.bodies.length).toBe(1);
    await labels.locator('button[aria-label]').click();
    if (edit === 'replace') {
      // The sent words are out of the input and its label is gone: the person presses into it to write the next one.
      // Home just after the input regains focus would be taken by ProseMirror for the browser's own reset and undone.
      await field(page).click();
      await page.keyboard.insertText('#T112');
      await page.getByRole('listbox').getByRole('option').first().click();
      current = (await labels.locator('.tabular-nums').textContent())!;
      expect(current).not.toBe(original);
    }
    posts.release();
    await expect(thread(page).locator('[data-coordinator-turn=succeeded]')).toHaveCount(1);
    await expect(field(page)).not.toContainText('First message.');
    await keepShot(page, `admitted-context-${edit}`);
    if (edit === 'replace') await expect(labels.locator('.tabular-nums')).toHaveText(current!);
    else await expect(labels).toHaveCount(0);
    await field(page).press('End'); await page.keyboard.insertText('Next message.');
    await page.locator('[data-coordinator-card] [data-ask-send]').click();
    await expect.poll(() => posts.bodies.length).toBe(2);
    expect((posts.bodies[0] as any).tasks).toEqual([original]);
    expect((posts.bodies[1] as any).tasks ?? []).toEqual(current ? [current] : []);
  } finally { posts.release(); }
});
});

test('unknown delivery is said once on its message and resends the same fixed request', async ({ page, runtime }) => {
  const posts = hold(page); await ready(page, runtime); posts.set('cut');
  await field(page).fill('Uncertain delivery words'); await page.locator('[data-ask-send]').click();
  const row = thread(page).locator('[data-coordinator-local=unknown]');
  await expect(row).toContainText("Couldn't confirm whether it arrived.");
  await expect(row.locator('[data-coordinator-resend]')).toHaveCount(1);
  await expect(page.locator('[data-toast][data-kind=error]')).toHaveCount(0);
  await expect(field(page)).toHaveText('');
  const original = posts.bodies[0]!;
  posts.set('pass'); await row.locator('[data-coordinator-resend]').click();
  await expect(thread(page).locator('[data-coordinator-turn=succeeded]')).toHaveCount(1);
  expect(posts.bodies).toHaveLength(2);
  expect(posts.bodies[1]).toEqual(original);
});
