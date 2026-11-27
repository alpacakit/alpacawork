import { expect, test } from "vitest";
import type { Task } from "../src/data/types";
import { GUIDE, PARTS, closing, doneOnLeaving, doneOnShowing, finishedHere, guideEntry, guideScreen, nextStage, saidBefore, startsGuide, stepsLeft, stillReads, type GuideFacts } from "../src/features/guide/guide-definition";
import { awaiting, coordinatorFacts, doneSince, foundDraft, pushOff } from "../src/features/guide/use-guide";
import { bringInAt, frontPart, placeBalloon, roomUnder, seenPart } from "../src/features/guide/Guide";

const started = { stage: "started", at: 1, seen: [] } as const;
const turn = { stage: "turn", seen: [] } as const;
const facts = (over: Partial<GuideFacts>): GuideFacts =>
  ({ screen: "computer", stage: started, tasks: 0, doneHere: false, settling: false, soon: false, conversationOpen: false, skipped: new Set(), talked: false, direct: false, questions: 0, results: 0, working: 0, unowned: 0, labelled: false, sent: false, busy: false, drafting: false,
    open: null, pushOff: false, apps: false, seen: new Set(), standing: null, ...over });
const shown = (over: Partial<GuideFacts>) => guideEntry(facts(over))?.id ?? null;
const read = (...ids: string[]) => new Set(ids);

test("the first request goes from the input to the coordinator and its Task", () => {
  expect(shown({})).toBe("send");
  expect(shown({ drafting: true })).toBe("send-ready");
  expect(shown({ sent: true, busy: true })).toBe("received");
  expect(shown({ tasks: 1, working: 1, sent: true })).toBe("working");
  // Answered in the conversation with no Task, the guide says once that that is where the reply is; then back to writing.
  expect(shown({ sent: true, talked: true, direct: true })).toBe("direct");
  expect(shown({ sent: true, talked: true, direct: true, seen: read("direct") })).toBe("send-again");
});

test("a Task left with no AI on it is not said to be the AI's, but only once the coordinator is no longer on it", () => {
  expect(shown({ tasks: 1, working: 1, unowned: 1, sent: true, busy: true })).toBe("received");
  expect(shown({ tasks: 1, working: 1, unowned: 1, sent: true })).toBe("unassigned");
  expect(shown({ tasks: 2, working: 2, unowned: 1, sent: true })).toBe("working");
});

test("a question: its row, then its choices until the answer is sent, then the coordinator on it", () => {
  expect(shown({ tasks: 1, questions: 1 })).toBe("question");
  expect(shown({ tasks: 1, questions: 1, open: "question", drafting: true })).toBe("answer");
  expect(shown({ tasks: 1, questions: 1, open: "question", busy: true })).toBe("received");
});

test("a report open: more can be asked first, then its label once while something is written, then Done", () => {
  const report = { stage: turn, tasks: 1, results: 1, open: "result" } as const;
  expect(shown({ stage: turn, tasks: 1, results: 1 })).toBe("result");
  expect(shown(report)).toBe("more");
  // With words already written, the report goes straight to sending them.
  expect(shown({ ...report, drafting: true })).toBe("send-ready");
  expect(shown({ ...report, seen: read("more"), drafting: true, labelled: true })).toBe("label");
  expect(shown({ ...report, seen: read("more") })).toBe("accept");
});

test("words in the input point at sending them wherever the guide is, but for a question's answer and the label", () => {
  const report = { stage: turn, tasks: 1, results: 1, open: "result", seen: read("more") } as const;
  expect(shown({ ...report, drafting: true })).toBe("send-ready");
  expect(shown({ ...report, seen: read("more", "label"), drafting: true, labelled: true })).toBe("send-ready");
  expect(shown({ tasks: 1, questions: 1, open: "question", drafting: true })).toBe("answer");
});

test("a step with no button is done once its balloon has stood; one with a button by it, or left when it no longer holds", () => {
  const entry = (over: Partial<GuideFacts>) => guideEntry(facts(over));
  const report = { stage: turn, tasks: 1, results: 1, open: "result" } as const;
  const label = entry({ ...report, seen: read("more"), drafting: true, labelled: true });
  const accept = entry({ ...report, seen: read("more") });
  expect([label?.id, accept?.id]).toEqual(["label", "accept"]);
  expect(doneOnShowing(label!, true)).toBe(true);
  expect(doneOnShowing(accept!, true)).toBe(true);
  // Not on the screen yet (its part in another project, under a dialog, or gone within a blink): still to be shown.
  expect(doneOnShowing(accept!, false)).toBe(false);
  // Done, it goes on standing in its first words while it stays the step on this page; moved on from, or the page
  // loaded again, it is the step in its words for coming round again.
  const standing = facts({ ...report, seen: read("more", "accept"), standing: "accept" }), back = facts({ ...report, seen: read("more", "accept") });
  expect([guideEntry(standing)?.id, saidBefore(accept!, standing)]).toEqual(["accept", false]);
  expect([guideEntry(back)?.id, saidBefore(accept!, back)]).toEqual(["accept", true]);
  // Put away by its button, a step is gone at once, standing or not.
  expect(shown({ ...report, seen: read("more"), standing: "more" })).toBe("accept");
  expect(shown({ stage: turn, doneHere: true, tasks: 1, talked: true, seen: read("conversation"), standing: "conversation" })).toBe("another-repository");
  // With a button: showing it does not put it away; pushed aside while it still holds, it waits; left because it no
  // longer holds (the conversation cleared, say), it is done.
  const more = entry(report);
  expect(more?.id).toBe("more");
  expect(doneOnShowing(more!, true)).toBe(false);
  expect(doneOnLeaving(more, accept, facts(report), true)).toBe(false);
  const conversation = entry({ stage: turn, doneHere: true, tasks: 1, talked: true });
  expect(conversation?.id).toBe("conversation");
  expect(doneOnLeaving(conversation, null, facts({ stage: turn, doneHere: true, tasks: 1, talked: false }), true)).toBe(true);
  expect(doneOnLeaving(conversation, null, facts({ stage: turn, doneHere: true, tasks: 1, talked: false }), false)).toBe(false);
});

test("through a first Task the guide always has a step: each explained once, then said in short as it comes round again", () => {
  const all = read(...GUIDE.map(entry => entry.id));
  const round = (over: Partial<GuideFacts>) => { const f = facts({ stage: turn, tasks: 1, talked: true, seen: all, ...over }), entry = guideEntry(f); return [entry?.id, !!entry && saidBefore(entry, f)]; };
  // One more request on the same Task, sent from its open report: the coordinator has it, the Task is worked on again,
  // its next question comes (seen in the detail, or as a row), its answer is sent, and its report comes to Done.
  expect(round({ results: 1, open: "result", drafting: true, labelled: true })).toEqual(["send-ready", true]);
  expect(round({ busy: true })).toEqual(["received", true]);
  expect(round({ working: 1, open: "working" })).toEqual(["working", true]);
  expect(round({ questions: 1, open: "question" })).toEqual(["answer", true]);
  expect(round({ questions: 1 })).toEqual(["question", true]);
  expect(round({ results: 1 })).toEqual(["result", true]);
  expect(round({ results: 1, open: "result" })).toEqual(["accept", true]);
  // Nothing going on: a request is to be written. Not while what was just answered or finished is on its way.
  expect(round({})).toEqual(["send-again", true]);
  expect(round({ settling: true })).toEqual([undefined, false]);
  // Nor is the coordinator said to have a message that can still be taken back, the conversation open or not.
  expect(round({ busy: true, soon: true })).toEqual([undefined, false]);
  // Nor, while what was sent from an open question or report is still with the coordinator, is it said to await them.
  expect(round({ results: 1, open: "result", busy: true, soon: true })).toEqual([undefined, false]);
  expect(round({ questions: 1, open: "question", busy: true, soon: true })).toEqual([undefined, false]);
  // Once a Task is finished here, nothing is said again: the close is read whatever else awaits the person (another
  // Task's question), and the guide is over with it.
  expect(round({ doneHere: true, questions: 1, seen: read("working", "question", "answer", "received") })).toEqual(["conversation", false]);
  expect(round({ doneHere: true, questions: 1 })).toEqual([undefined, false]);
  // What only explains is never the step again: the request to try after a report, the label, where an AI is stopped,
  // a reply in the conversation itself, and the close.
  for (const entry of GUIDE) expect([entry.id, !!entry.again]).toEqual([entry.id, !["send", "more", "label", "stop", "direct", "conversation", "another-repository", "phone", "phone-grip", "phone-swipe", "phone-notify"].includes(entry.id)]);
});

test("a request to try is the one way on its step offers: no \"Got it\" stands beside it", () => {
  for (const id of ["send", "more", "send-again"]) expect(GUIDE.find(entry => entry.id === id)).toMatchObject({ action: expect.anything() });
  for (const id of ["send", "more", "send-again"]) expect(GUIDE.find(entry => entry.id === id)?.next).toBeUndefined();
});

test("words waiting in the input come before the close, shown or not: the close waits and the guide is not over", () => {
  const done = { stage: turn, doneHere: true, tasks: 1, talked: true } as const;
  expect(shown({ ...done, drafting: true })).toBe("send-ready");
  // Sending was shown before: it is said again, and the guide waits for the words to be sent or taken away.
  const waiting = facts({ ...done, drafting: true, seen: read("send-ready") });
  expect(guideEntry(waiting)?.id).toBe("send-ready");
  expect(nextStage(turn, guideEntry(waiting), closing(waiting))).toBeUndefined();
  expect(shown({ ...done, seen: read("send-ready") })).toBe("conversation");
});

test("a passable step is passed over, not done, while what it points at is not seen; with only it left, the guide waits", () => {
  const close = { stage: turn, doneHere: true, tasks: 1, apps: true, seen: read("conversation") } as const;
  expect(shown(close)).toBe("another-repository");
  const hidden = { ...close, skipped: read("another-repository") };
  expect(shown(hidden)).toBe("phone");
  expect(doneOnLeaving(guideEntry(facts(close)), guideEntry(facts(hidden)), facts(hidden), true)).toBe(false);
  // Nothing else holds: it stays the step (showing nothing) rather than the guide ending.
  expect(shown({ ...hidden, seen: read("conversation", "phone") })).toBe("another-repository");
});

test("an answer given in the conversation itself is pointed at while it is folded; opened, the step no longer holds", () => {
  const answered = { sent: true, talked: true, direct: true } as const;
  expect(shown(answered)).toBe("direct");
  // Before other work going on, after the person's own turn.
  expect(shown({ ...answered, tasks: 1, working: 1, unowned: 1 })).toBe("direct");
  expect(shown({ ...answered, tasks: 1, questions: 1 })).toBe("question");
  expect(shown({ ...answered, conversationOpen: true })).toBe("send-again");
  expect(doneOnShowing(guideEntry(facts(answered))!, true)).toBe(true);
});

test("a Task being worked on, opened before anything has come back from it, points once at where it is stopped", () => {
  expect(shown({ tasks: 1, working: 1, open: "working" })).toBe("stop");
  expect(shown({ tasks: 1, working: 1, open: "working", seen: read("stop") })).toBe("working");
  // Once the person has had a turn, the detail stays open on the Task they answered: its work going on is what is said.
  expect(shown({ stage: turn, tasks: 1, working: 1, open: "working", seen: read("working") })).toBe("working");
});

test("with a report and a question both awaiting the person, the question's step points at the question's row", () => {
  document.body.innerHTML = '<li data-row-section="review" data-row-turn="result" id="report"></li><li data-row-section="review" data-row-turn="question" id="question"></li>';
  const entry = guideEntry(facts({ tasks: 2, questions: 1, results: 1 }));
  expect(entry?.id).toBe("question");
  expect(document.querySelector(PARTS[entry!.part!])?.id).toBe("question");
  expect(document.querySelector(PARTS.resultRow)?.id).toBe("report");
});

test("once Done is pressed here the guide closes in steps read once each, before other work, and is over when they are read", () => {
  const done = { stage: turn, doneHere: true, tasks: 2, talked: true } as const;
  // Before Done here, finished work elsewhere does not close it: a Task being worked on is said.
  expect(shown({ stage: turn, tasks: 2, working: 1, talked: true })).toBe("working");
  expect(shown({ ...done, working: 1, unowned: 1 })).toBe("conversation");
  expect(shown({ ...done, results: 1 })).toBe("result");
  expect(shown({ ...done, busy: true })).toBe("received");
  expect(shown({ ...done, seen: read("conversation") })).toBe("another-repository");
  expect(shown({ ...done, talked: false })).toBe("another-repository");
  // Read to the end, other work going on or not, the guide is over.
  const read_ = facts({ ...done, working: 1, unowned: 1, seen: read("conversation", "another-repository") });
  expect(guideEntry(read_)).toBeNull();
  expect(nextStage(turn, null, closing(read_))).toEqual({ stage: "done", read: true });
  // Where settings hold the steps to answering from a phone, pointing at them once is the last step.
  expect(shown({ ...done, apps: true, seen: read("conversation", "another-repository") })).toBe("phone");
});

test("shown again over a list with nothing going on, the guide begins at sending a request", () => {
  expect(shown({ tasks: 4 })).toBe("send-again");
  expect(shown({ tasks: 4, sent: true, busy: true })).toBe("received");
});

test("the guide starts by itself only for a new person: never stored, on the welcome, with no Task in the whole workspace", () => {
  const at = (welcome: boolean, tasks: number) => ({ screen: "computer", welcome, tasks }) as const;
  expect(startsGuide("computer", null, at(true, 0))).toBe(true);
  expect(startsGuide("computer", null, at(true, 3))).toBe(false);
  expect(startsGuide("computer", null, at(false, 0))).toBe(false);
  expect(startsGuide("computer", { stage: "done" }, at(true, 0))).toBe(false);
});

test("a phone has a guide of its own: started on a phone's first look whatever the work, and kept apart from the computer's", () => {
  expect([guideScreen(false, true), guideScreen(true, true), guideScreen(true, false)]).toEqual(["computer", "phone", null]);
  expect(startsGuide("phone", null, { screen: "phone", welcome: false, tasks: 12 })).toBe(true);
  expect(startsGuide("phone", null, { screen: "computer", welcome: true, tasks: 0 })).toBe(false);
  expect(startsGuide("phone", { stage: "done" }, { screen: "phone", welcome: false, tasks: 12 })).toBe(false);
});

test("on a phone: an open question or report says its grip, then its swipes, once each, and notifications are pointed at once", () => {
  const phone = (over: Partial<GuideFacts>) => shown({ screen: "phone", tasks: 3, questions: 1, results: 1, ...over });
  // A card open: its grip first, then its swipes (before notifications); once each read, nothing more on it.
  expect(phone({ open: "result" })).toBe("phone-grip");
  expect(phone({ open: "question", pushOff: true })).toBe("phone-grip");
  expect(phone({ open: "question", seen: read("phone-grip") })).toBe("phone-swipe");
  expect(phone({ open: "result", seen: read("phone-grip", "phone-swipe") })).toBeNull();
  expect(GUIDE.filter(entry => entry.id.startsWith("phone-") && entry.id !== "phone-notify").map(entry => entry.show)).toEqual(["sheet", "swipe"]);
  // Notifications, while made sure to be off, until put away.
  expect(phone({ pushOff: true })).toBe("phone-notify");
  expect(phone({ pushOff: true, seen: read("phone-notify") })).toBeNull();
  // None of the computer's steps is shown on a phone, and neither of these on a computer.
  expect(phone({ tasks: 0, questions: 0, results: 0 })).toBeNull();
  expect(shown({ tasks: 1, results: 1, open: "result", pushOff: true, seen: read("more", "accept") })).toBe("accept");
  // Once both are read, nothing is left to say or to read for it; a computer's guide always has a step left, and never
  // reads this browser's push state.
  expect(stepsLeft("phone", ["phone-grip", "phone-swipe"]).map(entry => entry.id)).toEqual(["phone-notify"]);
  expect(stepsLeft("phone", ["phone-grip", "phone-swipe", "phone-notify"])).toEqual([]);
  expect(stepsLeft("computer", GUIDE.map(entry => entry.id)).length).toBeGreaterThan(0);
  expect(stepsLeft("computer", []).some(entry => entry.reads?.length)).toBe(false);
  // A Task finished on a phone does not end its guide: only a computer's has a close.
  const finished = facts({ screen: "phone", doneHere: true });
  expect([closing(finished), nextStage(started, guideEntry(finished), closing(finished))]).toEqual([false, undefined]);
});

test("the guide reaches the person's turn once a step of theirs holds, and is over only when nothing holds in the close", () => {
  expect(nextStage(started, guideEntry(facts({ tasks: 1, questions: 1 })), false)).toEqual({ stage: "turn", seen: [] });
  expect(nextStage(started, guideEntry(facts({ tasks: 1, working: 1 })), false)).toBeUndefined();
  expect(nextStage(turn, null, true)).toEqual({ stage: "done", read: true });
  // Nothing to show before a Task is finished here (its Done taken back, the Task put on hold): the guide waits.
  expect(nextStage(turn, null, false)).toBeUndefined();
  // What the stage keeps goes along as it moves on.
  expect(nextStage({ ...started, finished: ["T2"] }, guideEntry(facts({ tasks: 1, questions: 1 })), false)).toEqual({ stage: "turn", seen: [], finished: ["T2"] });
  expect(shown({ stage: turn, tasks: 1, doneHere: true, talked: true })).toBe("conversation");
});

test("the coordinator is busy while anything sent is still with it, and a request is the guide's once sent after it began", () => {
  const at = "2026-01-01T00:00:00Z";
  expect(coordinatorFacts({ since: null, sending: [], turns: [{ id: "a", at, status: "running" }] })).toMatchObject({ sent: false, busy: true });
  expect(coordinatorFacts({ since: null, sending: ["b"], turns: [] }).busy).toBe(true);
  expect(coordinatorFacts({ since: Date.parse(at), sending: [], turns: [{ id: "a", at, status: "succeeded" }] })).toMatchObject({ sent: true, busy: false });
  // Answered there, writing to no Task: a direct answer. One that made or wrote a Task is not.
  expect(coordinatorFacts({ since: null, sending: [], turns: [{ id: "a", at, status: "succeeded", result: { writes: [] } }] }).direct).toBe(true);
  expect(coordinatorFacts({ since: null, sending: [], turns: [{ id: "a", at, status: "succeeded", result: { writes: [{}] } }] }).direct).toBe(false);
  // Read already (with the conversation open as it came): nothing to point at.
  expect(coordinatorFacts({ since: null, sending: [], turns: [{ id: "a", at, status: "succeeded", result: { writes: [] }, seen: true }] }).direct).toBe(false);
});

test("a balloon stands right by its part, clear of the boxes it is told to, on the side where that is nearest", () => {
  const view = { width: 1360, height: 900 };
  const send = { left: 940, top: 846, width: 32, height: 32 }, foot = { left: 380, top: 655, width: 600, height: 235 };
  const button = { left: 380, top: 607, width: 120, height: 36 };
  const size = { width: 200, height: 48 };
  // Beside the foot, at the send button's own height: nearer than over the foot.
  const beside = placeBalloon(send, size, view, "right", "middle", [foot, button]);
  expect(beside).toMatchObject({ side: "right", x: send.left + send.width + 12 });
  expect(beside.x).toBeGreaterThanOrEqual(foot.left + foot.width);
  expect(beside.y + beside.arrow).toBe(send.top + send.height / 2);
  // No room beside it (the foot as wide as the view): over the foot, not over the button standing clear of its left end.
  const wide = { ...foot, left: 8, width: 1344 }, far = { ...send, left: 1300 };
  const over = placeBalloon(far, size, view, "right", "middle", [wide, button]);
  expect(over).toMatchObject({ side: "top", y: wide.top - 12 - size.height });
  expect(over.x + over.arrow).toBe(far.left + far.width / 2);
  // A box in its way there is stood clear of as well.
  const panel = { left: 8, top: 200, width: 1344, height: 443 };
  expect(placeBalloon(far, size, view, "right", "middle", [wide, panel]).y).toBe(panel.top - 12 - size.height);
  const asked = { left: 887, top: 424, width: 432, height: 404 }, detail = { left: 832, top: 12, width: 516, height: 876 };
  const left = placeBalloon(asked, { width: 496, height: 68 }, view, "left", "start", [detail]);
  expect(left.x + 496).toBeLessThanOrEqual(detail.left);
  expect(left.y).toBe(asked.top);
  // A detail taking the whole screen leaves no room round it: the balloon stands by the question, not over it.
  const whole = placeBalloon(asked, { width: 496, height: 68 }, view, "left", "start", [{ left: 0, top: 0, ...view }]);
  expect(whole.x + 496).toBeLessThanOrEqual(asked.left);
  // A conversation taking all the room over the input: never over the input it was told to keep clear; with no room
  // anywhere round it but over the input, over its own head.
  const conversation = { left: 8, top: 12, width: 1344, height: 636 }, across = { ...foot, left: 0, width: view.width };
  const head = placeBalloon(conversation, size, view, "top", "middle", [across]);
  expect(head).toMatchObject({ side: "top", y: 8 });
  const aside = placeBalloon({ ...conversation, left: 380, width: 600 }, size, view, "top", "middle", [foot]);
  const overlap = aside.x < foot.left + foot.width && aside.x + size.width > foot.left && aside.y + size.height > foot.top;
  expect(overlap).toBe(false);
});

test("shown again from its first screen, the guide points at the input whatever the work, until something is written or sent", () => {
  const intro = { stage: "started", at: 1, seen: [], intro: true } as const;
  expect(shown({ stage: intro, tasks: 4, questions: 1, working: 2 })).toBe("send");
  expect(nextStage(intro, guideEntry(facts({ stage: intro, tasks: 4, questions: 1 })), false)).toBeUndefined();
  expect(nextStage(intro, guideEntry(facts({ stage: intro, tasks: 4, drafting: true })), false)).toEqual({ stage: "started", at: 1, seen: [] });
  expect(nextStage(intro, guideEntry(facts({ stage: intro, tasks: 4, sent: true, busy: true })), false)).toEqual({ stage: "started", at: 1, seen: [] });
});

test("shown again, what the input already held is not writing; a change to it is", () => {
  const intro = { stage: "started", at: 5, seen: [], intro: true } as const;
  const found = foundDraft(intro, "old words", null);
  expect(found?.same).toBe(true);
  expect(foundDraft(intro, "old words", found)?.same).toBe(true);
  expect(foundDraft(intro, "old words and more", found)?.same).toBe(false);
  expect(foundDraft(started, "old words", found)).toBeNull();
});

test("a box under the balloon gets room at its end from the balloon's top down, and none when the balloon is off it", () => {
  const sheet = { top: 300, bottom: 844 };
  expect(roomUnder(sheet, { top: 600, bottom: 700 })).toBe(244);
  expect(roomUnder(sheet, { top: 250, bottom: 320 })).toBe(594);
  expect(roomUnder(sheet, { top: 100, bottom: 200 })).toBe(0);
});

test("a row partly under a detail widened over the list is ringed only where it is seen", () => {
  const row = { left: 24, top: 185, width: 533, height: 33 };
  const middle = { x: 290, y: 201 };
  // The detail lies over the list from 428 rightwards: the ring, drawn 4px outside its part, stops short of it.
  expect(frontPart(row, middle, x => x < 428)).toEqual({ left: 24, top: 185, width: 400, height: 33 });
  // Covered from the left (to 100), the same from that side.
  expect(frontPart(row, middle, x => x >= 100)).toEqual({ left: 104, top: 185, width: 453, height: 33 });
  // Nothing over it, or only the next row's edge touching its last pixel: the whole row.
  expect(frontPart(row, middle, () => true)).toEqual(row);
  expect(frontPart(row, middle, (_, y) => y < 217.4)).toEqual(row);
});

test("a part reaching under the input at a detail's foot is pointed at where it is seen, above the input", () => {
  // A phone's sheet from 282 to 844, keeping 162px at its foot for the input and its row: the question's box runs past that.
  const question = { left: 37, top: 362, width: 341, height: 448 };
  expect(seenPart(question, { top: 282, bottom: 682 })).toEqual({ left: 37, top: 362, width: 341, height: 320 });
  // Seen whole, it is pointed at whole.
  expect(seenPart({ ...question, height: 200 }, { top: 282, bottom: 682 })).toEqual({ ...question, height: 200 });
});

test("a part taller than what its pane shows above the input is brought in from its head, though the whole pane could hold it", () => {
  // A phone's sheet 562px tall, 400px of it seen above the input and its row: a 448px question is brought to its head.
  const seen = { top: 282, bottom: 682 };
  expect(bringInAt(448, seen)).toBe("start");
  expect(bringInAt(300, seen)).toBe("nearest");
});

test("after each of two replies that make no Task, the step at the input is shown again, its button used or not", () => {
  const first = facts({ sent: true, talked: true, seen: read("send", "received", "direct") });
  expect(shown(first)).toBe("send-again");
  // Its demo request put in and replaced by another question, sent and answered in the conversation: put away and left.
  const second = facts({ sent: true, talked: true, seen: read("send", "received", "direct", "send-again", "send-ready") });
  expect(shown(second)).toBe("send-again");
  expect(shown({ ...second, standing: null })).toBe("send-again");
});

test("a row whose turn the person has already answered from here is not theirs, while it still stands in the list", () => {
  const rows = [{ taskId: "T1", section: "review" }, { taskId: "T2", section: "review" }];
  const task = (id: string) => ({ id, ball: { holder: "user", reason: "result" } }) as unknown as Task;
  const byId = new Map([["T1", task("T1")], ["T2", task("T2")]]);
  expect(awaiting(rows, byId, () => false, "T1")).toEqual({ questions: 0, results: 2, open: "result" });
  expect(awaiting(rows, byId, each => each.id === "T1", "T1")).toEqual({ questions: 0, results: 1, open: null });
});

test("Done pressed before the guide began (again) is not its own; Done pressed since is, on the same Task too", () => {
  const again = { stage: "started", at: 9, seen: [], intro: true } as const;
  const old = { press: "R1", task: "T1" };
  const first = doneSince(again, [old], null);
  expect(first.fresh).toEqual([]);
  expect(doneSince(again, [old], first).fresh).toEqual([]);
  const later = doneSince(turn, [old], first);
  expect(later.fresh).toEqual([]);
  // Pressed while any step shows (words waiting to be sent, say): it is the guide's.
  expect(doneSince(turn, [old, { press: "R5", task: "T5" }], later).fresh).toEqual(["T5"]);
  // The Task finished before the guide began, opened again and Done pressed on it again: a new press, the guide's.
  expect(doneSince(turn, [{ press: "R7", task: "T1" }], later).fresh).toEqual(["T1"]);
});

test("the close holds while the server says a Task pressed Done on here is finished, and nothing else opens it", () => {
  const states = (each: Record<string, string>) => (id: string) => each[id];
  // Done, and finished: in the list, or let go by it and read again (the detail closed, the page loaded again).
  expect(finishedHere(["T2"], states({ T2: "done" }))).toEqual(["T2"]);
  // An old Task opened again and finished again counts as well, whatever was finished before the guide began.
  expect(finishedHere(["T1", "T7"], states({ T1: "review", T7: "done" }))).toEqual(["T7"]);
  // Done on its way or taken back (still awaiting), the Task put on hold, stopped, or not known yet: no close.
  for (const state of ["review", "held", "stopped", undefined]) expect(finishedHere(["T2"], states(state ? { T2: state } : {}))).toEqual([]);
  // A Task stopped with no Done pressed on it here is not among those pressed on.
  expect(finishedHere([], states({ T3: "stopped" }))).toEqual([]);
  // Taken back and put on hold: nothing goes on, so a request is to be written, and the guide is not over; awaiting
  // again, Done is what holds on it (pressing Done again goes on to the close).
  const held = facts({ stage: turn, tasks: 1, talked: true, doneHere: finishedHere(["T2"], states({ T2: "held" })).length > 0 });
  expect(guideEntry(held)?.id).toBe("send-again");
  expect(nextStage(turn, guideEntry(held), closing(held))).toBeUndefined();
  expect(shown({ stage: turn, tasks: 1, talked: true, results: 1, open: "result", seen: read("more", "accept") })).toBe("accept");
});

test("while notifications cannot be told to be off, their step is not chosen and an open card's step is", () => {
  const phone = (over: Partial<GuideFacts>) => shown({ screen: "phone", tasks: 3, questions: 1, results: 1, pushOff: false, ...over });
  expect(phone({})).toBeNull();
  expect(phone({ open: "question" })).toBe("phone-grip");
  expect(phone({ open: "result", seen: read("phone-grip", "phone-swipe") })).toBeNull();
});

test("a step stood and then not to be told now is not put away; one whose facts no longer hold is, as on a computer", () => {
  const notify = guideEntry(facts({ screen: "phone", pushOff: true }));
  expect(notify?.id).toBe("phone-notify");
  expect(doneOnLeaving(notify, null, facts({ screen: "phone", pushOff: false }), true)).toBe(false);
  const card = facts({ screen: "phone", open: "question", pushOff: false });
  expect(doneOnLeaving(notify, guideEntry(card), card, true)).toBe(false);
  const conversation = guideEntry(facts({ stage: turn, doneHere: true, tasks: 1, talked: true }));
  expect(doneOnLeaving(conversation, null, facts({ stage: turn, doneHere: true, tasks: 1, talked: false }), true)).toBe(true);
});

test("just before reading, what is stored now says whether a step left still reads it: none once put away or ended", () => {
  expect(stillReads("phone", { stage: "started", at: 1, seen: ["phone-grip"] }, "push")).toBe(true);
  expect(stillReads("phone", { stage: "started", at: 1, seen: ["phone-notify"] }, "push")).toBe(false);
  expect([stillReads("phone", { stage: "done" }, "push"), stillReads("phone", null, "push"), stillReads("computer", started, "push")]).toEqual([false, false, false]);
});

test("notifications are off only when this browser made sure: it can have them, they are not blocked, and its subscription was read and there is none", () => {
  const read = (subscribed: boolean, permission: NotificationPermission = "default") => ({ permission, subscribed });
  expect([pushOff(true, read(false)), pushOff(true, read(false, "granted"))]).toEqual([true, true]);
  expect([pushOff(false, read(false)), pushOff(true, read(false, "denied")), pushOff(true, read(true, "granted")), pushOff(true, "reading"), pushOff(true, "failed")])
    .toEqual([false, false, false, false, false]);
});
