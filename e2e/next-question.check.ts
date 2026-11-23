
import { commandFetch as fetch } from "../tests/helpers/command-fetch.ts";
import type { Page } from "@playwright/test";
import { test as base, expect as baseExpect, settleMotion, openCoordinator } from "./fixtures.ts";
import { writeFileSync } from 'node:fs';
import { start, type Runtime } from "./server.ts";
import { configureCoordinator, startFakeCoordinator, foldConversation } from "./coordinator-fixture.ts";
import { patchTask, seedQuestion, seedReview } from "./fixture/task-state.ts";
import { readTaskLog } from "./task-history.ts";
import { coordinatorSnapshotSchema, coordinatorMessageInputSchema } from '@alpacawork/contract/coordinator';
import { decideValues } from '../tests/helpers/task-values.ts';
import type { TaskValues } from '@alpacawork/contract';

// Answering the question the reader shows sends its card off stamped, and the reader goes on to the next
// question. Each case waits for the flight and the next card's coming forward to end, never for a time. A press (✔, H,
// the state form) goes to the coordinator as the user's intent and its card leaves at its receipt; a choice only goes
// into the draft, and what is sent the coordinator writes, quoting the user's words (e2e/fixture/fake-coordinator.mjs).
// The next card is the next one the server lists (its home projection).
const expect = baseExpect.configure({ timeout: 20_000 });

/**
 * Each case has its own served copy whose coordinator carries out what it is sent, and its own project, so the list it
 * opens on (and the reader's questions) holds only the questions the case makes.
 */
const test = base.extend<{ runtime: Runtime; project: string }>({
  runtime: async ({}, use) => {
    const runtime = await start(undefined, startFakeCoordinator);
    try { await use(runtime); } finally { await runtime.stop(); }
  },
  project: async ({ runtime }, use) => {
    await use((await post<Written>(runtime, "commands/task/new", { kind: "project", color: '#39659b', parent: "none", title: "Decision check" })).task.id);
  },
});
test.describe.configure({ timeout: 90_000 });
// Its sends from the input are read leaving their cards: auto-swipe on.
test.use({ autoSwipe: true });

const reader = (page: Page) => page.locator("aside[data-reader-mode]");
const shown = (page: Page) => reader(page).locator("header [data-reader-task-id]");
/** ✔ (Approve) sends the approval to the coordinator at once. */
const approve = (page: Page) => page.locator("[data-task-done]").click();
const flying = (page: Page) => page.locator("[data-flying-card]");

/** The flight has ended: the copy removed itself and the card that came forward is still. */
async function settled(page: Page) {
  await expect(flying(page)).toHaveCount(0);
  await expect.poll(() => reader(page).evaluate(card => card.getAnimations().length)).toBe(0);
}

/** Every animation the page starts, kept so a case can say which ones ran (the shake leaves no lasting trace). */
async function recordAnimations(page: Page) {
  await page.addInitScript(() => {
    const seen: { target: string; keyframes: string; stamp: string | null }[] = [];
    (window as unknown as { animationsSeen: typeof seen }).animationsSeen = seen;
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (this: Element, keyframes, options) {
      seen.push({ target: this.matches("aside[data-reader-mode]") ? "reader" : this.matches("[data-flying-card]") ? "flying" : this.matches("[data-ring-piece]") ? "ring" : "other",
        keyframes: JSON.stringify(keyframes), stamp: this.querySelector("[data-stamp]")?.textContent ?? null });
      return animate.call(this, keyframes, options);
    };
  });
}
const animationsOf = (page: Page, target: string) =>
  page.evaluate(name => (window as unknown as { animationsSeen: { target: string; keyframes: string }[] }).animationsSeen
    .filter(item => item.target === name).map(item => JSON.parse(item.keyframes) as Keyframe[]), target);

type Written = { task: { id: string; hash: string } };
async function post<Result>(runtime: Runtime, path: string, body: object): Promise<Result> {
  const response = await fetch(`${runtime.origin}/api/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await response.text();
  baseExpect(response.status, text).toBe(200);
  return JSON.parse(text) as Result;
}
/** One Task as `task get` reads it: its state, version and questions including closed records. */
async function taskOf(runtime: Runtime, id: string) {
  const response = await fetch(`${runtime.origin}/api/commands/task/get?task=${encodeURIComponent(id)}`);
  baseExpect(response.status).toBe(200);
  return await response.json() as { task: { state: string; hash: string }; questions: { id: string; destination: { kind: 'user' | 'task' }; state: 'open' | 'answered' | 'withdrawn' | 'expired' }[] | null };
}
const stateOf = async (runtime: Runtime, id: string) => (await taskOf(runtime, id)).task.state;

/** A Task the user asks for in the case's project, with its responsible placed: what each question below is asked on. */
async function requested(runtime: Runtime, project: string, title: string, values?: TaskValues) {
  const { task } = await post<Written>(runtime, "commands/task/new", { parent: project, title, ...values === undefined ? {} : { values } });
  await post(runtime, "commands/agent/assign", { task: task.id, role: "responsible", profile: "codex", expectedTaskHash: task.hash });
  return task.id;
}
/** A new review: its responsible's Run reported done (seedReview), so ✔ confirms it. It joins the waiting list's end. */
async function question(runtime: Runtime, project: string, title: string) {
  const id = await requested(runtime, project, title);
  seedReview(runtime.root, id, { description: "Please review the answer." });
  return id;
}
/** `count` new reviews, made oldest first. */
async function questions(runtime: Runtime, project: string, count: number) {
  const ids: string[] = [];
  for (let at = 1; at <= count; at++) ids.push(await question(runtime, project, `Decision request ${at}`));
  return ids;
}
const DECIDE = decideValues(['Which option', ['Option1 Send current input', 'Send'], ['Option2 Decide later', 'Hold it']]);
/**
 * A new question to the user: its responsible, at work, asks the body's question (seedQuestion; a question keeps the
 * state, so the Task is at work first). A choice of it goes into the coordinator's draft.
 */
async function asked(runtime: Runtime, project: string, title: string) {
  const id = await requested(runtime, project, title, DECIDE);
  patchTask(runtime.root, id, { state: "doing" });
  seedQuestion(runtime.root, id, { to: "user" });
  return id;
}
/** The Waiting for you rows among `ids` in the order the server lists them (its home projection): the reader's order. */
async function serverOrder(runtime: Runtime, ids: readonly string[]) {
  const index = await (await fetch(`${runtime.origin}/api/workspace/live`)).json() as { home: { taskId: string; section: string }[] };
  return index.home.filter(row => row.section === "review" && ids.includes(row.taskId)).map(row => row.taskId);
}
/** The coordinator carried the press or the answer out: the Task's record of `kind` quotes the user's words. */
async function quoted(runtime: Runtime, task: string, kind: "review_approved" | "answered", words: RegExp) {
  await expect.poll(async () => {
    const actor = (await readTaskLog(runtime.origin, task)).find(entry => entry.kind === kind)?.actor;
    return kind === "review_approved" ? actor?.kind === "human" : actor?.kind === "main" && typeof actor.quote === "string" && words.test(actor.quote);
  }).toBe(true);
}

/** Opens the reader on `task` in the case's project; a review shows its ✔ once a press can go to the coordinator. */
async function begin(page: Page, runtime: Runtime, project: string, task: string) {
  await page.goto(`${runtime.origin}/?project=${project}&task=${task}`);
  await expect(shown(page)).toHaveText(task);
  if ((await stateOf(runtime, task)) === "waiting") await expect(page.locator("[data-task-done]")).toBeEnabled();
  else await expect(reader(page).locator('[data-question="1"]')).toBeVisible();
}

test("an answer flies the card off stamped and the next question comes forward; Back returns to the answered one without moving again; the last says every question was answered", async ({ page, runtime, project }) => {
  const [first, second] = await serverOrder(runtime, await questions(runtime, project, 2));
  await page.setViewportSize({ width: 1440, height: 900 });
  await recordAnimations(page);
  // Where the copy stands when its flight ends: a docked card starts away from the screen's edge (departure.ts's box.left).
  await page.addInitScript(() => {
    const cancel = Animation.prototype.cancel;
    Animation.prototype.cancel = function () {
      const target = (this.effect as KeyframeEffect)?.target;
      if (target instanceof Element && target.matches("[data-flying-card]") && this.playState === "finished")
        ((window as unknown as { flightEnds: { left: number }[] }).flightEnds ??= []).push({ left: target.getBoundingClientRect().left });
      return cancel.call(this);
    };
  });
  await begin(page, runtime, project, first!);
  await expect(page.locator("[data-turn-pager]")).toHaveCount(0);
  // The answered card leaving is the flight alone: no crossfade's copy is laid over the reader as well.
  await page.evaluate(() => {
    const counted = { copies: 0 };
    (window as unknown as { crossfades: typeof counted }).crossfades = counted;
    new MutationObserver(records => { for (const record of records) for (const node of record.addedNodes)
      if (node instanceof Element && node.hasAttribute("data-still-copy") && !node.hasAttribute("data-flying-card")) counted.copies++; }).observe(document, { childList: true, subtree: true });
  });
  const crossfades = () => page.evaluate(() => (window as unknown as { crossfades: { copies: number } }).crossfades.copies);
  await approve(page);
  await expect(flying(page).locator("[data-stamp]")).toHaveText("Done");
  await baseExpect(flying(page)).toHaveAttribute("data-flying-card", "done");
  // The reader under the copy is already on the next question.
  await expect(shown(page)).toHaveText(second!);
  await settled(page);
  await expect.poll(() => new URL(page.url()).searchParams.get("task")).toBe(second);
  // The stamp said it; no toast says it again.
  await expect(page.locator("[data-toast]")).toHaveCount(0);
  const flights = await animationsOf(page, "flying");
  baseExpect(String(flights[0]!.at(-1)!.transform)).toMatch(/^translate\(\d/);
  baseExpect(await page.evaluate(() => (window as unknown as { flightEnds?: { left: number }[] }).flightEnds?.some(end => end.left > innerWidth))).toBe(true);
  baseExpect(await crossfades()).toBe(0);
  // The press went as the user's words, and the coordinator confirmed the review quoting them.
  await quoted(runtime, first!, "review_approved", new RegExp(`^Approve ${first}$`));
  await expect.poll(() => stateOf(runtime, first!)).toBe("done");

  await page.goBack();
  await expect(shown(page)).toHaveText(first!);
  // Back is the reader turned to another task by hand: what it showed dissolves into it.
  await expect.poll(crossfades).toBe(1);
  // The answered task is done: completion is no longer available.
  await expect(page.locator("[data-task-done]")).toHaveCount(0);
  baseExpect(await flying(page).count()).toBe(0);
  await page.goForward();
  await expect(shown(page)).toHaveText(second!);

  await approve(page);
  // The last: the answered card says every question was answered, with a ring of one piece per answer and how each was answered.
  await expect(reader(page).getByText("You've answered everything awaiting review")).toBeVisible();
  await expect(reader(page).locator("[data-answered-ring]")).toHaveAttribute("data-answered-ring", "2");
  await expect(reader(page).locator("[data-answered-count]")).toHaveText("2 done");
  await settled(page);
  // Once its own motion is over, the ring is whole, the tick drawn, and the words and Close fully shown.
  const end = reader(page).locator("[data-empty-deck]");
  await expect.poll(() => end.evaluate(box => box.getAnimations({ subtree: true }).every(each => each.playState === "finished"))).toBe(true);
  const drawn = await end.evaluate(box => ({
    pieces: [...box.querySelectorAll("[data-ring-piece]")].map(piece => Number.parseFloat(getComputedStyle(piece).strokeDasharray)),
    tick: getComputedStyle(box.querySelector("[data-answered-ring] path")!).strokeDashoffset,
    shown: [...box.children].map(child => getComputedStyle(child).opacity),
  }));
  baseExpect(drawn.pieces).toHaveLength(2);
  baseExpect(drawn.pieces.every(length => length > 100)).toBe(true);
  baseExpect(Number.parseFloat(drawn.tick)).toBe(0);
  baseExpect(drawn.shown).toEqual(["1", "1", "1"]);
  await expect(shown(page)).toHaveText(second!);
  // Close has the focus: Enter closes the reader.
  await expect(reader(page).getByRole("button", { name: "Close", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(reader(page)).toHaveCount(0);
});

test("a choice only goes into the draft; sent, the card flies off to the server's next one and the coordinator writes the answer quoting the user's words", async ({ page, runtime, project }) => {
  const choice = await asked(runtime, project, "Option choice question");
  const [review] = await questions(runtime, project, 1);
  const order = await serverOrder(runtime, [choice, review!]);
  baseExpect(order).toHaveLength(2);
  await page.setViewportSize({ width: 1440, height: 900 });
  await begin(page, runtime, project, choice);
  let sends = 0;
  page.on("request", request => { if (new URL(request.url()).pathname === "/api/coordinator/messages") sends++; });
  await reader(page).locator('[data-question="1"]').getByRole("button", { name: /Option1/ }).click();
  await expect(page.locator('[data-label-layer] [data-label="answer"]')).toContainText("Option1");
  // Pressed, the choice is only in the draft: nothing went, the question is still open and its card stays.
  await settleMotion(page);
  baseExpect(sends).toBe(0);
  baseExpect((await taskOf(runtime, choice)).questions?.some(each => each.destination.kind === "user" && each.state === "open")).toBe(true);
  await expect(shown(page)).toHaveText(choice);
  await expect(flying(page)).toHaveCount(0);
  // Sent, the card leaves as it goes, and the reader goes on to the next card the server lists.
  await page.locator("[data-ask-send]").click();
  await expect(flying(page)).toHaveAttribute("data-flying-card", "send");
  await expect(shown(page)).toHaveText(order.find(id => id !== choice)!);
  await settled(page);
  baseExpect(sends).toBe(1);
  // The coordinator answered the question with what the user sent, quoting it.
  await quoted(runtime, choice, "answered", /1-Option1/);
  await expect.poll(async () => (await taskOf(runtime, choice)).questions?.some(each => each.destination.kind === "user" && each.state === "open") ?? false).toBe(false);
});

test("a refused optimistic approval keeps the next card and its notice opens the failed card", async ({ page, runtime, project }) => {
  const [first, second] = await serverOrder(runtime, await questions(runtime, project, 2));
  await begin(page, runtime, project, first!);
  await page.route(url => url.pathname === "/api/commands/task/report", route => route.fulfill({ status: 409,
    json: { error: { code: "conflict", message: "Task changed", retry: "reread" } } }));
  await approve(page);
  const notice = page.locator("[data-toast]");
  await expect(notice.getByRole("button", { name: "Open" })).toBeVisible();
  // The local submission already advanced. A refusal cannot steal the next card; Open returns to its source.
  await expect(shown(page)).toHaveText(second!);
  await notice.getByRole("button", { name: "Open" }).click();
  await expect(shown(page)).toHaveText(first!);
  await expect(flying(page)).toHaveCount(0);
  await expect.poll(() => stateOf(runtime, first!)).toBe("waiting");
});

// A reply submitted from the open card is independent of whether its words promise a particular CLI write.
test.describe('free-text answer submission', () => {
  test.use({ locale: 'ja-JP', isMobile: true, hasTouch: true, viewport: { width: 412, height: 915 } });
});

/** This coordinator returns successfully without answering the Task's question.
 * Keep the existing cases' write-performing coordinator separate from this fixture. */
const residualQuestionTest = base.extend<{ project: string }>({
  isolated: true,
  fixedTime: false,
  retainRuntime: true,
  runtimePrepare: async ({}, use) => { await use(configureCoordinator); },
  project: async ({ runtime }, use) => {
    await use((await post<Written>(runtime, 'commands/task/new', { kind: 'project', color: '#39659b', parent: 'none', title: 'Residual question regression' })).task.id);
  },
});

// The regression read the deck with one card and with two; each runs once, at a width of its own.
for (const [width, count] of [[390, 1]] as [number, 1 | 2][]) residualQuestionTest(
  `completed free text keeps the same question out of the automatic deck (${width}, ${count} cards)`,
  async ({ page, runtime, project }, info) => {
    const observations: unknown[] = [];
    const sends: ReturnType<typeof coordinatorMessageInputSchema.parse>[] = [];
    const conversation = async () => {
      const response = await fetch(`${runtime.origin}/api/coordinator`);
      baseExpect(response.ok).toBe(true);
      return coordinatorSnapshotSchema.parse(await response.json()).conversation;
    };
    // Observe the persisted browser boundary, without writing its store or calling product internals.
    const localSubmissions = () => page.evaluate(() => {
      const raw = sessionStorage.getItem('alpacawork-input-drafts-v10');
      const entries = raw ? JSON.parse(raw).entries as Record<string, { values: Record<string, string> }> : {};
      return Object.entries(entries).filter(([, entry]) => !!entry.values.reader).map(([key, entry]) => ({
        key, requestId: entry.values.requestId, stage: entry.values.stage, reader: JSON.parse(entry.values.reader!),
      }));
    });
    const capture = async (label: string) => {
      const observation = { label, width, count, sends, shown: await shown(page).textContent(),
        empty: await page.locator('[data-empty-deck]').count(), reader: await reader(page).innerText(),
        tasks: await Promise.all(ids.map(async id => ({ id, ...await taskOf(runtime, id) }))),
        conversation: await conversation(), submissions: await localSubmissions() };
      observations.push(observation);
      await page.screenshot({ path: info.outputPath(`${label}.png`) });
      await info.attach(label, { contentType: 'application/json', body: JSON.stringify(observation, null, 2) });
    };
    const ids: string[] = [];
    for (let at = 0; at < count; at++) ids.push(await asked(runtime, project, `Residual question ${at + 1}`));
    const original = await Promise.all(ids.map(async id => ({ id, question: (await taskOf(runtime, id)).questions!.find(each => each.state === 'open')!.id })));
    const unchangedQuestions = async () => {
      for (const { id, question } of original) {
        const current = (await taskOf(runtime, id)).questions!.filter(each => each.state === 'open' && each.destination.kind === 'user');
        baseExpect(current.map(each => each.id), `The coordinator must leave ${id}'s original question open`).toEqual([question]);
      }
    };
    const receivedResult = async (id: string) => {
      await expect.poll(async () => {
        const turn = (await conversation()).turns.find(each => each.id === id);
        return { status: turn?.status, result: turn?.result };
      }).toMatchObject({ status: 'succeeded', result: { writes: [], refused: [] } });
      await expect.poll(async () => (await localSubmissions()).find(each => each.requestId === id)?.stage).toBe('settled');
      await unchangedQuestions();
      // Persistence happens before subscribers render. Cross the browser's real paint boundary before checking the deck.
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await settled(page);
    };
    const sendWords = async (words: string) => {
      if (await page.locator('[data-coordinator-expand]').first().isVisible()) await openCoordinator(page);
      await page.locator('[data-one-input]').click();
      await page.locator('[data-one-input]').press('End');
      await page.keyboard.insertText(words);
      await expect(page.locator('[data-ask-send]')).toBeEnabled();
      await page.locator('[data-ask-send]').click();
      await foldConversation(page);
    };
    // Hold only the first POST until its local departure is observed. This makes the temporary empty state observable,
    // but neither a transport delay nor that temporary state can satisfy the result/settled assertions below.
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    let first = true;
    await page.route('**/api/coordinator/messages', async route => {
      sends.push(coordinatorMessageInputSchema.parse(route.request().postDataJSON()));
      if (first) { first = false; await firstGate; }
      await route.continue();
    });
    try {
      await page.setViewportSize({ width, height: 900 });
      await begin(page, runtime, project, ids[0]!);
      await capture('before-send');
      await sendWords('Please proceed with blue.');
      await expect.poll(() => sends.length).toBe(1);
      if (count === 1) await expect(reader(page).locator('[data-empty-deck]')).toBeVisible();
      else await expect(shown(page)).toHaveText(ids[1]!);
      await capture('locally-submitted');
      releaseFirst();
      await receivedResult(sends[0]!.id);
      await capture('first-result-settled');
      if (count === 2) {
        await expect(shown(page)).toHaveText(ids[1]!);
        await sendWords('Please proceed with red.');
        await expect.poll(() => sends.length).toBe(2);
        await receivedResult(sends[1]!.id);
        await capture('second-result-settled');
      }
      // This is the regression assertion: on old main one card reappears, or A returns after B, with the SAME Q ID.
      await expect(reader(page).locator('[data-empty-deck]'), 'A completed free-text send must remain outside the automatic deck').toBeVisible();
      await expect(reader(page).getByText("You've answered everything awaiting review")).toBeVisible();
      await expect(shown(page)).toHaveText(ids.at(-1)!);
      await unchangedQuestions();
      // A visually covered question must not remain operable through Tab/Space or exposed to assistive readers.
      const close = reader(page).locator('[data-empty-deck]').getByRole('button', { name: 'Close', exact: true });
      const keyboard: unknown[] = [];
      const inputBefore = await page.evaluate(() => sessionStorage.getItem('alpacawork-input-drafts-v10'));
      let hiddenQuestion = false, hiddenControl = false;
      for (const key of ['Tab', 'Shift+Tab']) {
        await close.focus();
        for (let step = 0; step < 32; step++) {
          await page.keyboard.press(key);
          const focus = await reader(page).evaluate(root => {
            const active = document.activeElement;
            return { hidden: !!active && root.contains(active) && !active.closest('[data-empty-deck]'),
              question: !!active?.closest('[data-question]'), label: active?.getAttribute('aria-label'), text: active?.textContent?.slice(0, 100) };
          });
          keyboard.push({ key, step, ...focus });
          hiddenControl ||= focus.hidden;
          if (focus.hidden && focus.question) { hiddenQuestion = true; break; }
        }
        if (hiddenQuestion) break;
      }
      if (hiddenQuestion) await page.keyboard.press('Space');
      const inputAfter = await page.evaluate(() => sessionStorage.getItem('alpacawork-input-drafts-v10'));
      const aria = await reader(page).ariaSnapshot();
      await info.attach('completion-keyboard', { contentType: 'application/json', body: JSON.stringify({ keyboard, inputBefore, inputAfter, aria }, null, 2) });
      await page.screenshot({ path: info.outputPath('completion-after-keyboard.png') });
      baseExpect(hiddenControl, 'Tab and Shift+Tab must skip everything covered by completion').toBe(false);
      baseExpect(inputAfter, 'Keyboard navigation must not change an invisible answer').toBe(inputBefore);
      baseExpect(aria).not.toContain('Option1');
      baseExpect(aria).not.toContain('Residual question');
      // A document shortcut is outside inert's DOM boundary. The completed surface must also end that listener's life.
      const beforeHold = await taskOf(runtime, ids.at(-1)!);
      await close.focus();
      const holdRequest = page.waitForRequest(request => request.method() === 'POST' &&
        new URL(request.url()).pathname === '/api/commands/task/report', { timeout: 1000 }).catch(() => null);
      await page.keyboard.press('h');
      const hiddenHold = await holdRequest;
      const afterHold = await taskOf(runtime, ids.at(-1)!);
      await info.attach('completion-hold-key', { contentType: 'application/json', body: JSON.stringify({
        request: hiddenHold?.postDataJSON() ?? null, before: beforeHold.task, after: afterHold.task,
      }, null, 2) });
      baseExpect(hiddenHold, 'H on completion must not submit the covered task').toBeNull();
      baseExpect(afterHold.task.hash, 'H on completion must not change the covered task').toBe(beforeHold.task.hash);
      // A manual opening starts a fresh visible card, without clearing the durable submitted fact or blocking follow-up.
      await close.focus();
      await page.keyboard.press(width === 390 ? 'Space' : 'Enter');
      await expect(reader(page)).toHaveCount(0);
      await page.locator(`[data-read="${ids[0]}"]`).first().click();
      await expect(shown(page)).toHaveText(ids[0]!);
      await expect(reader(page).locator('[data-empty-deck]')).toHaveCount(0);
      // A reload opens this card manually, but must retain the submitted facts for every automatic candidate.
      await page.reload();
      await expect(shown(page)).toHaveText(ids[0]!);
      await expect.poll(async () => (await localSubmissions()).filter(each => each.stage === 'settled').length).toBe(count);
      await sendWords('Please also keep the original wording.');
      await expect.poll(() => sends.length).toBe(count + 1);
      await receivedResult(sends.at(-1)!.id);
      await expect(reader(page).locator('[data-empty-deck]')).toBeVisible();
      await capture('manual-follow-up-settled');
      // The same words under a new question identity must become answerable again, without clearing another Task's fact.
      patchTask(runtime.root, ids[0]!, { logs: [{ id: crypto.randomUUID(), kind: 'question_withdrawn',
        at: new Date().toISOString(), title: null, description: null, actor: { kind: 'human' },
        fromState: null, toState: null, questionId: original[0]!.question }] });
      const renewed = seedQuestion(runtime.root, ids[0]!, { to: 'user', title: 'A new question with the same words' });
      baseExpect(renewed).not.toBe(original[0]!.question);
      await expect.poll(async () => (await taskOf(runtime, ids[0]!)).questions!.filter(each => each.state === 'open').map(each => each.id)).toEqual([renewed]);
      await expect(reader(page).locator('[data-empty-deck]')).toHaveCount(0);
      await expect(shown(page)).toHaveText(ids[0]!);
      await reader(page).locator('[data-question="1"]').getByRole('button', { name: /Option1/ }).click();
      await expect(page.locator('[data-ask-send]')).toBeEnabled();
      await capture('new-question-answerable');
      // Opening a visible card restores the ordinary document shortcut, independently of its earlier submitted fact.
      await page.locator(`[data-read="${ids[0]}"]`).first().focus();
      await page.keyboard.press('h');
      await expect.poll(() => stateOf(runtime, ids[0]!)).toBe('held');
    } finally {
      releaseFirst();
      writeFileSync(info.outputPath('residual-question-observations.json'), JSON.stringify({ width, count, original, sends, observations }, null, 2));
    }
  },
);
