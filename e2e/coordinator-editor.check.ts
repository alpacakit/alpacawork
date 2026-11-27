import { labelLayer } from './editor-surface.ts';
import { coordinatorSnapshotSchema } from "@alpacawork/contract/coordinator";
import { prepareQuestion as prepare, askAgain } from './question-fixture.ts';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, open, openCoordinator, fakeMicrophone, writeCoordinator, settleMotion, configureVoice } from './fixtures.ts';
import { applyPageClock } from './page-clock.ts';
import { startFakeCoordinator, foldConversation } from './coordinator-fixture.ts';
import { RunStore } from '@alpacawork/runs';
import type { Locator, Page } from '@playwright/test';
import type { Runtime } from './server.ts';
const card = (page: Page) => page.locator('[data-coordinator-card], [data-coordinator-panel]');
const panel = (page: Page) => page.locator('[data-coordinator-panel]');
const field = (page: Page) => page.locator('[data-one-input]');
const shots = process.env.COORDINATOR_EDITOR_SHOTS;
const shot = async (page: Page, name: string) => { if (shots) { mkdirSync(shots, { recursive: true }); await page.screenshot({ path: join(shots, name + '.png') }); } };
test.use({ isolated: true });
test.describe.configure({ timeout: 90_000 });
// Its sends from the input are read leaving their cards: auto-swipe on.
test.use({ autoSwipe: true });
/** `write`: the input brought up from its line at once (the checks of what comes before need it down). */
async function begin(page: Page, runtime: Runtime, phone = false, write = true) {
  const question = await prepare(runtime);
  await page.setViewportSize(phone ? { width: 390, height: 844 } : { width: 1440, height: 900 });
  await open(page, runtime, '?agent=1&task=T112');
  // The reader keeps no writing of its own; its foot holds no band: the coordinator's input is at the
  // screen's, folded to one line until it is pressed.
  await expect(page.locator('[data-coordinator-folded] [data-coordinator-capsule]')).toBeVisible();
  await expect(page.locator('aside[data-reader-mode] [data-question="1"]')).toBeVisible();
  if (write) await writeCoordinator(page);
  await expect(page.locator('aside[data-reader-mode] textarea, [data-answer-bar], [data-composer], [data-composer-dock]')).toHaveCount(0);
  return question;
}
/** Folded, the coordinator is its input alone at the screen's foot. */
const folded = (page: Page) => page.locator('[data-coordinator-folded]');
async function launch(page: Page) { await openCoordinator(page); await expect(field(page)).toBeVisible(); }

test('question choices enter ordered answer badges, toggle, remove context, survive reload and send exactly to the coordinator', async ({ page, runtime }) => {
  await begin(page, runtime);
  await page.locator('[data-question="2"]').getByRole('button', { name: /Option2/ }).click();
  await page.locator('[data-question="1"]').getByRole('button', { name: /Option1/ }).click();
  await expect(labelLayer(field(page)).locator('[data-label=answer]')).toHaveText(['1Option1', '2Option2']);
  // A choice hands the focus to the input (a frame later): pressed before it lands, End would act on the caret the
  // input had before the choice went in.
  await expect(field(page)).toBeFocused();
  await field(page).press('End'); await page.keyboard.insertText('Shorter labels are easier to read.');
  await shot(page, 'pc-answer');
  const label = labelLayer(field(page)).locator('[data-label=task] button').first(); await label.click();
  await expect(page.locator('[data-badge-card]')).toContainText('T112'); await shot(page, 'pc-badge-card');
  await page.keyboard.press('Escape'); await expect(page.locator('[data-coordinator-card]')).toBeVisible();
  await page.keyboard.press('Escape'); await expect(folded(page)).toBeVisible();
  await launch(page); await expect(labelLayer(field(page)).locator('[data-label=answer]')).toHaveCount(2);
  await page.reload(); await launch(page); await expect(field(page)).toContainText('easier to read');
  // Its label taken off, the draft is the person's: the open panel does not put it back.
  await labelLayer(field(page)).locator('[data-label=task] button').last().click();
  await expect(labelLayer(field(page)).locator('[data-label=task]')).toHaveCount(0);
  await panel(page).getByRole('button', { name: 'Close the conversation', exact: true }).click(); await launch(page);
  await expect(labelLayer(field(page)).locator('[data-label=task]')).toHaveCount(0);
  const sent = page.waitForRequest(r => r.url().endsWith('/api/coordinator/messages') && r.method() === 'POST');
  await field(page).press('ControlOrMeta+Enter');
  const body = (await sent).postDataJSON();
  // The answers name their Task; what the screen shows is sent nowhere.
  expect(body).not.toHaveProperty('context'); expect(body.tasks).toEqual(['T112']);
  expect(body.text).toBe('T112 1-Option1 2-Option2 Shorter labels are easier to read.');
  await expect(card(page).locator('[data-ask-answer]')).toHaveCount(1); await shot(page, 'pc-sent');
  // The turn's mark on the rail sits level with its message's head line: on the middle of its time's capitals.
  const level = await card(page).locator('[data-coordinator-mark]').first().evaluate(mark => {
    const time = mark.closest('div')!.querySelector('time')!, words = document.createRange();
    words.selectNodeContents(time);
    const style = getComputedStyle(time), pen = document.createElement('canvas').getContext('2d')!;
    pen.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const capital = pen.measureText('H'), baseline = words.getClientRects()[0]!.top + capital.fontBoundingBoxAscent;
    const at = mark.getBoundingClientRect();
    return Math.abs(at.top + at.height / 2 - (baseline - capital.actualBoundingBoxAscent / 2));
  });
  expect(level).toBeLessThanOrEqual(1);
});

test('an open skill list refreshes after discovery; failed revalidation does not send a stale skill', async ({ page, runtime }) => {
  await begin(page, runtime, false, false);
  let release!: () => void, unavailable = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/coordinator/skills?*', async route => {
    await gate;
    await route.fulfill({ json: unavailable ? { status: 'unavailable', profile: 'fake', skills: [], reason: 'changed' } :
      { status: 'ready', profile: 'fake', skills: [{ name: 'alpacawork', description: 'Manage tasks', invocation: '/' }] } });
  });
  await launch(page); await expect(labelLayer(field(page)).locator('[data-label=task]')).toHaveCount(1); await expect(labelLayer(field(page)).locator('[data-label=task]')).toContainText('T112');
  await expect(field(page)).toHaveAttribute('contenteditable', 'true'); await field(page).press('End'); await page.keyboard.insertText('/');
  await expect(page.getByRole('listbox')).toContainText('Available skills could not be verified');
  release(); await expect(page.getByRole('listbox').getByRole('option')).toContainText('alpacawork');
  await page.keyboard.press('Enter'); unavailable = true;
  let sent = false; page.on('request', req => { if (req.url().endsWith('/api/coordinator/messages')) sent = true; });
  await card(page).locator('[data-ask-send]').click();
  // A reader submission reports definite preflight refusal once through the shared toast and returns its skill.
  await expect(page.locator('[data-toast]')).toHaveCount(1);
  // Another card may already be current; Open returns the refused submission without taking that card's draft.
  await page.locator('[data-toast]').getByRole('button', { name: 'Open', exact: true }).click();
  if (!await field(page).isVisible()) await writeCoordinator(page);
  await expect(labelLayer(field(page)).locator('[data-label=skill]')).toContainText('alpacawork');
  await expect(page.locator('[data-empty-deck]')).toHaveCount(0); expect(sent).toBe(false);
});

// A choice and an Other with its words, both on the question that then changes: one draft, one send, under the original identity.
test('a withdrawn question\'s chips, a choice and an Other with its words, reach the real coordinator CLI as an ordinary request and withdraw the newer question', async ({ page, runtime }) => {
  const question = await begin(page, runtime);
  startFakeCoordinator(runtime.root);
  await page.locator('[data-question="1"]').getByRole('button', { name: /Option1/ }).click();
  const chip = labelLayer(field(page)).locator(`[data-label=answer][data-answer-question="${question}"]`);
  await expect(chip).toHaveCount(1);
  await page.locator('[data-question="2"]').getByRole('button', { name: 'Other', exact: true }).click();
  await expect(chip).toHaveCount(2);
  await page.keyboard.insertText('Keep the original wording');
  const unchanged = await chip.first().getAttribute('class');
  const original = (await (await page.request.get(runtime.origin + '/api/task/view?task=T112')).json()).questions.find((q: any) => q.id === question).text;
  const again = await askAgain(runtime, question, values => JSON.parse(JSON.stringify(values)
    .replace('How to open suggestions', 'Publication scope').replace('Option1 Complete from a number', 'Option1 Publish to everyone')));
  await expect(page.locator('[data-question="1"]').getByRole('button', { name: /Option1 Publish to everyone/ })).toBeVisible();
  const old = page.locator(`[data-report-key="log:T112:${question}"] article`);
  await expect(old).toHaveAttribute('data-released', 'withdrawn');
  await expect(old).toContainText('Withdrawn');
  await expect(chip.first()).toHaveAttribute('class', unchanged!);
  const history = await (await page.request.get(runtime.origin + '/api/task/history?task=T112&children=1&limit=80')).json();
  expect(history.events.find((e: any) => e.id === question)).toMatchObject({ open: false, closure: 'withdrawn' });
  // The withdrawal is still recorded, and told only by the old card: no row of its own above the new question.
  const withdrawal = history.events.find((e: any) => e.kind === 'withdrawn');
  expect(withdrawal).toBeTruthy();
  await expect(page.locator(`[data-report-key="log:T112:${withdrawal.id}"]`)).toHaveCount(0);
  await expect(page.locator('[data-report-key]').filter({ hasText: 'Question withdrawn' })).toHaveCount(0);
  const sent = page.waitForRequest(request => request.url().endsWith('/api/coordinator/messages'));
  await field(page).press('ControlOrMeta+Enter');
  const body = (await sent).postDataJSON();
  expect(body.answers).toEqual([{ task: 'T112', question }]);
  expect(body.intent).toBeUndefined();
  // Both go under the original choices' words: the Other as `other` with what was written after it.
  expect(body.text).toContain('1-Option1'); expect(body.text).toContain('2-other Keep the original wording');
  await expect.poll(async () => {
    const response = await page.request.get(runtime.origin + '/api/coordinator');
    expect(response.ok()).toBe(true);
    const conversation = coordinatorSnapshotSchema.parse(await response.json()).conversation;
    return conversation.turns.some((turn: any) => turn.result?.writes.some((write: any) =>
      write.task === 'T112' && write.kind === 'request_accepted' && write.question === question));
  }, { timeout: 30_000 }).toBe(true);
  const detail = await (await page.request.get(runtime.origin + '/api/task/view?task=T112')).json();
  // A late answer keeps its original identity as an ordinary instruction; resumption closes the current question too.
  expect(detail.questions.map((q: any) => [q.id, q.state])).toEqual([[question, 'withdrawn'], [again, 'withdrawn']]);
  expect(detail.questions.find((q: any) => q.id === question).text).toBe(original);
  const runs = RunStore.openReadable(runtime.root, { busyTimeoutMs: 1000 })!;
  try {
    const requests = runs.snapshot().requests;
    expect(requests.filter(request => request.answersQuestion === question).map(request => request.purpose)).toEqual(['instruction']);
    expect(requests.some(request => request.answersQuestion === again)).toBe(false);
  } finally { runs.close(); }
  await expect(chip).toHaveCount(0); await expect(page.locator('[data-toast]')).toHaveCount(0);
});







test('closing and reopening during answer delivery retains both immutable submissions in order', async ({ page, runtime }) => {
  await begin(page, runtime);
  await page.locator('[data-question="1"]').getByRole('button', { name: /Option1/ }).click();
  let release!: () => void, reached!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), checking = new Promise<void>(resolve => { reached = resolve; });
  await page.route('**/api/coordinator/messages', async route => {
    reached(); await gate;
    await route.continue();
  });
  const asks: {id:string;text:string}[] = []; page.on('request', request => { if (request.url().endsWith('/api/coordinator/messages')) asks.push(request.postDataJSON()); });
  await field(page).press('ControlOrMeta+Enter'); await checking;
  try {
    // Folding and reopening retains the original until admission: it stands as its own message at the conversation's end
    // with its Task and answer, and nothing of it is in the input, where only the added words form the next send.
    await foldConversation(page);
    await launch(page);
    await expect(field(page)).toHaveAttribute('contenteditable', 'true');
    const first = card(page).locator(`[data-coordinator-message="${asks[0]!.id}"]`);
    await expect(first.locator('[data-label=task]')).toHaveAttribute('title', /^T112/);
    await expect(first).toContainText(/1\s*Option1/);
    const inInput = (await field(page).evaluate((el: any) => JSON.stringify(el.editor.getJSON())));
    expect(inInput).not.toContain('answerLabel'); expect(inInput).not.toContain('"T112"');
    // This second message is general conversation. The same unadmitted question turn cannot be submitted twice.
    await field(page).press('ControlOrMeta+a'); await field(page).press('Backspace');
    await page.keyboard.insertText('Added');
    await expect(card(page).locator('[data-ask-send]')).toBeEnabled();
    await field(page).press('ControlOrMeta+Enter'); expect(asks).toHaveLength(1);
    await expect(card(page).locator('[data-coordinator-local]').filter({ hasText: 'Added' })).toHaveCount(1);
    await expect(field(page)).not.toContainText('Added');
  } finally { release(); }
  await expect.poll(() => asks.length).toBe(2);
  expect(asks[0]!.text).not.toContain('Added'); expect(asks[1]!.text).toContain('Added');
  expect(asks[0]!.id).not.toBe(asks[1]!.id);
  // The first is the immutable answer to T112's question; the second answers nothing.
  expect((asks[0] as any).tasks).toEqual(['T112']); expect((asks[0] as any).answers?.map((each: any) => each.task)).toEqual(['T112']);
  expect((asks[1] as any).answers ?? []).toEqual([]);
  await expect(field(page)).not.toContainText('Added');
});

// A source checkout maintains its skills without a release-install receipt. Check the real send boundary.
test('source development sends a managed skill without requiring npm installation', async ({ page, runtime }) => {
  await page.route('**/api/coordinator/skills?*', route => route.fulfill({ json: { status: 'ready', profile: 'fake',
    skills: [{ name: 'alpacawork', description: 'Manage tasks', invocation: '/' }] } }));
  await begin(page, runtime, true);
  await field(page).press('End'); await page.keyboard.insertText('Use /');
  await expect(page.getByRole('listbox')).toContainText('alpacawork'); await page.keyboard.press('Enter');
  await page.keyboard.insertText(' to answer');
  const response = page.waitForResponse(r => new URL(r.url()).pathname === '/api/coordinator/messages' && r.request().method() === 'POST');
  await field(page).press('ControlOrMeta+Enter');
  const admitted = await response;
  expect(admitted.status(), await admitted.text()).toBe(200);
  expect(admitted.request().postDataJSON().skills).toEqual(['alpacawork']);
  await openCoordinator(page);
  await expect(card(page).locator('[data-ask-answer]')).toHaveCount(1);
});

const focusDocument = async (page: Page, phase: string) => test.info().attach(`focus-document-${phase}`, {
  contentType: 'application/json', body: JSON.stringify(await field(page).evaluate((el: any) => ({
    doc: el.editor.getJSON(), selection: el.editor.state.selection.toJSON(), connected: el.isConnected,
    active: el.ownerDocument.activeElement === el, domSelection: String(el.ownerDocument.getSelection()) }))) });
// A folded input keeps its editor detached. These checks cover
// this connection boundary. Drive the initiating control and type without focusing the field.
// Each way in opens its own tab (a tab keeps its own draft), so each starts folded with its editor detached.
// The ways whose result turns on the width (draft.ts answerInDraft): a computer's choice opens the input on it with
// focus, while on a phone only Other does (it asks for words); a phone's plain choice is the next check.
test('folded input hands initial focus to the input: answer at 1440px, other at 390px', async ({ page: first, context, runtime }) => {
  await prepare(runtime); await configureVoice(runtime);
  const ways = [[1440, 'answer'], [390, 'other']] as const;
  let page = first;
  for (const [at, [width, action]] of ways.entries()) await test.step(`${action} at ${width}px`, async () => {
    if (at) { if (page !== first) await page.close(); page = await context.newPage(); await applyPageClock(page, true); }
    await page.setViewportSize({ width, height: 900 });
    await open(page, runtime, '?agent=1&task=T112');
    await expect(page.locator('[data-coordinator-capsule]')).toBeVisible();
    await expect(field(page)).toHaveCount(0);
    if (action === 'answer') await page.locator('[data-question="1"]').getByRole('button', { name: /Option1/ }).click();
    else await page.locator('[data-question="1"]').getByRole('button', { name: 'Other', exact: true }).click();
    await expect(field(page)).toBeFocused();
    await focusDocument(page, `${action}-${width}-before-input`);
    await page.keyboard.insertText('Validation');
    await focusDocument(page, `${action}-${width}-after-input`);
    await expect(field(page)).toContainText('Validation');
    const doc = await field(page).evaluate((el: any) => el.editor.getJSON());
    expect(doc.content.at(-1).content.at(-1)).toEqual({ type: 'text', text: 'Validation' });
  });
});

/** Where focus is, whether in the input, and how far the page and the keyboard's room have moved. */
const settled = (page: Page) => page.evaluate(() => new Promise<{ editing: boolean; scroll: number; room: number }>(resolve =>
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const active = document.activeElement as HTMLElement | null;
    resolve({ editing: !!active && (active.isContentEditable || !!active.closest('[data-one-input], textarea, input')),
      scroll: Math.round(scrollY), room: Math.round(visualViewport!.height) });
  }))));

// On a phone a report's choice only writes the draft. The input stays as it is and nothing is focused, so no
// keyboard rises under the press and nothing scrolls; brought up later, the input holds the answers.
test('on a phone, answering leaves the input down and unfocused; brought up, it holds every answer and the words', async ({ browser, runtime }) => {
  await prepare(runtime);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  await open(page, runtime, '?agent=1&task=T112');
  const line = page.locator('[data-coordinator-folded] [data-coordinator-capsule]');
  await expect(line).toBeVisible();
  // Words written first and put down with a tap away stay with the answers.
  const words = 'A long draft written first. '.repeat(8).trim();
  await page.locator('[data-coordinator-write]').tap(); await expect(field(page)).toBeFocused();
  await field(page).press('End'); await page.keyboard.insertText(words);
  await page.locator('[data-question="1"] [data-question-number]').tap();
  await expect(field(page)).toHaveCount(0); await expect(line).toContainText(words.slice(0, 10));
  const before = await settled(page);
  expect(before.editing).toBe(false);
  const choice = (n: string, name: string) => page.locator(`[data-question="${n}"]`).getByRole('button', { name: new RegExp(name) });
  const presses: [Locator, number][] = [
    [choice('1', 'Option1'), 1],
    // Another question adds its own; choosing again replaces; the same choice again takes it back.
    [choice('2', 'Option2'), 2],
    [choice('1', 'Option2'), 2],
    [choice('2', 'Option2'), 1],
  ];
  for (const [press, count] of presses) {
    await press.tap();
    await expect(page.locator('[data-question] [aria-pressed=true]')).toHaveCount(count);
    expect(await settled(page)).toEqual(before);
    await expect(field(page)).toHaveCount(0); await expect(line).toBeVisible();
  }
  // Brought up by the person, the input holds the answer and the words.
  await page.locator('[data-coordinator-write]').tap();
  await expect(field(page)).toBeFocused();
  await expect(labelLayer(field(page)).locator('[data-label=answer]')).toHaveText(['1Option2']);
  await expect(field(page)).toContainText(words);
  // Up and focused, a choice keeps it up with the person's focus, and goes in.
  await choice('2', 'Option1').tap();
  await expect(labelLayer(field(page)).locator('[data-label=answer]')).toHaveText(['1Option2', '2Option1']);
  await settleMotion(page);
  await expect(field(page)).toBeVisible(); await expect(field(page)).toBeFocused();
  await context.close();
});

// One recovery flow at both input surfaces: a choice alone, words, then a file alone.
for (const phone of [false, true]) test.describe(`undo focus (${phone ? 'phone' : 'pc'})`, () => {
  test.use({ fixedTime: false, writeGraceMs: 3000, hasTouch: phone, isMobile: phone });
  test('undo focuses the restored input at its end, including answers and attachments alone', async ({ page, runtime }, info) => {
    await begin(page, runtime, phone, false);
    await page.locator('[data-question="1"]').getByRole('button', { name: /Option1/ }).click();
    await launch(page);
    const press = async (button: Locator) => phone ? button.tap() : button.click();
    const undo = async (name: string) => {
      const before = await field(page).evaluate((el: any) => el.editor.getJSON());
      await press(page.locator('[data-one-input-area] [data-ask-send]'));
      await press(page.locator('[data-coordinator-cancel-unsent]').filter({ visible: true }).first());
      await expect(field(page)).toBeFocused();
      await expect.poll(() => field(page).evaluate((el: any) => {
        const { doc, selection } = el.editor.state;
        return selection.empty && selection.$to.parentOffset === selection.$to.parent.content.size
          && selection.to === doc.content.size - 1;
      })).toBe(true);
      expect(await field(page).evaluate((el: any) => el.editor.getJSON())).toEqual(before);
      await page.screenshot({ path: info.outputPath(`${name}-after-undo.png`) });
      await info.attach(`${name}-focus`, { contentType: 'application/json', body: JSON.stringify(await field(page).evaluate((el: any) => {
        const { view, state } = el.editor, native = el.ownerDocument.getSelection();
        return { doc: state.doc.toJSON(), selection: state.selection.toJSON(), native: native?.anchorNode && {
          anchor: view.posAtDOM(native.anchorNode, native.anchorOffset), head: view.posAtDOM(native.focusNode, native.focusOffset), text: native.anchorNode.textContent } };
      })) });
    };
    await expect(labelLayer(field(page)).locator('[data-label=answer]')).toHaveCount(1);
    await undo('answer-only');
    // Type without clicking or focusing the field: the restored choice must precede the new words.
    await page.keyboard.insertText(' After answer');
    expect((await field(page).evaluate((el: any) => el.editor.getJSON())).content.at(-1).content.at(-1).text).toBe(' After answer');
    await undo('words');
    await page.keyboard.type(' appended');
    await expect(field(page)).toContainText(' After answer appended');
    await field(page).fill('');
    await page.locator('[data-one-input-area] input[type=file]').setInputFiles({ name: 'undo.txt', mimeType: 'text/plain', buffer: Buffer.from('Kept file bytes') });
    await expect(page.locator('[data-one-input-area] [data-attachment-state=saved]')).toHaveCount(1);
    await undo('file-only');
    await expect(page.locator('[data-one-input-area] [data-attachment="undo.txt"][data-attachment-state=saved]')).toHaveCount(1);
    await page.keyboard.insertText('After file');
    await expect(field(page)).toContainText('After file');
  });
});
