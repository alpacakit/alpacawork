import { expect, test } from "vitest";
import type { Task } from "../src/data/types";
import { PARTS, doneOnLeaving, finishedHere, guideEntry, nextStage, startsGuide, type GuideFacts } from "../src/features/guide/guide-definition";
import { awaiting, coordinatorFacts, doneSince, foundDraft } from "../src/features/guide/use-guide";
import { placeBalloon, roomUnder } from "../src/features/guide/Guide";

const started = { stage: "started", at: 1, seen: [] } as const;
const turn = { stage: "turn", seen: [] } as const;
const facts = (over: Partial<GuideFacts>): GuideFacts =>
  ({ stage: started, tasks: 0, doneHere: false, conversationOpen: false, skipped: new Set(), talked: false, direct: false, questions: 0, results: 0, working: 0, unowned: 0, labelled: false, sent: false, busy: false, drafting: false,
    open: null, narrow: false, apps: false, seen: new Set(), ...over });
const shown = (over: Partial<GuideFacts>) => guideEntry(facts(over))?.id ?? null;
const read = (...ids: string[]) => new Set(ids);

test("the first request goes from the input, on a computer or a phone, to the coordinator and its Task", () => {
  for (const narrow of [false, true]) {
    expect(shown({ narrow })).toBe("send");
    expect(shown({ narrow, drafting: true })).toBe("send-ready");
    expect(shown({ narrow, sent: true, busy: true })).toBe("received");
  }
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
  // On a phone's width the balloon over the input would stand over the report: straight to Done.
  expect(shown({ ...report, narrow: true })).toBe("accept");
});

test("words in the input point at sending them wherever the guide is, but for a question's answer and the label", () => {
  const report = { stage: turn, tasks: 1, results: 1, open: "result", seen: read("more") } as const;
  expect(shown({ ...report, drafting: true })).toBe("send-ready");
  expect(shown({ ...report, seen: read("more", "label"), drafting: true, labelled: true })).toBe("send-ready");
  expect(shown({ stage: turn, doneHere: true, tasks: 1, drafting: true })).toBe("send-ready");
  expect(shown({ tasks: 1, questions: 1, open: "question", drafting: true })).toBe("answer");
});

test("a step shown once with no button is done when the guide moves on from it; one with a button only by it", () => {
  const entry = (over: Partial<GuideFacts>) => guideEntry(facts(over));
  const label = entry({ stage: turn, tasks: 1, results: 1, open: "result", seen: read("more"), drafting: true, labelled: true });
  const accept = entry({ stage: turn, tasks: 1, results: 1, open: "result", seen: read("more") });
  expect(doneOnLeaving(label, accept, facts({}))).toBe(true);
  expect(doneOnLeaving(label, label, facts({}))).toBe(false);
  // With a button: pushed aside while it still holds, it waits; left because it no longer holds (the conversation
  // cleared, say), it is done.
  const more = entry({ stage: turn, tasks: 1, results: 1, open: "result" });
  expect(doneOnLeaving(more, accept, facts({ stage: turn, tasks: 1, results: 1, open: "result" }))).toBe(false);
  const conversation = entry({ stage: turn, doneHere: true, tasks: 1, talked: true });
  expect(conversation?.id).toBe("conversation");
  expect(doneOnLeaving(conversation, null, facts({ stage: turn, doneHere: true, tasks: 1, talked: false }))).toBe(true);
});

test("a step read once is passed over, not done, while what it points at is not seen; with only it left, the guide waits", () => {
  const close = { stage: turn, doneHere: true, tasks: 1, apps: true, seen: read("conversation") } as const;
  expect(shown(close)).toBe("another-repository");
  const hidden = { ...close, skipped: read("another-repository") };
  expect(shown(hidden)).toBe("phone");
  expect(doneOnLeaving(guideEntry(facts(close)), guideEntry(facts(hidden)), facts(hidden))).toBe(false);
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
  expect(doneOnLeaving(guideEntry(facts(answered)), guideEntry(facts({ ...answered, conversationOpen: true })), facts({ ...answered, conversationOpen: true }))).toBe(true);
});

test("a Task being worked on, seen in the detail, points once at where it is stopped", () => {
  expect(shown({ tasks: 1, working: 1, open: "working" })).toBe("stop");
  expect(shown({ tasks: 1, working: 1, open: "working", seen: read("stop") })).toBe("working");
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
  expect(shown({ ...done, working: 1, unowned: 1, seen: read("conversation", "another-repository") })).toBeNull();
  // Where settings hold the steps to answering from a phone, pointing at them once is the last step; never on a phone.
  expect(shown({ ...done, apps: true, seen: read("conversation", "another-repository") })).toBe("phone");
  expect(shown({ ...done, apps: true, narrow: true, seen: read("conversation", "another-repository") })).toBeNull();
});

test("shown again over a list with nothing going on, the guide begins at sending a request", () => {
  expect(shown({ tasks: 4 })).toBe("send-again");
  expect(shown({ tasks: 4, sent: true, busy: true })).toBe("received");
});

test("the guide starts by itself only for a new person: never stored, on the welcome, with no Task in the whole workspace", () => {
  expect(startsGuide(null, true, 0)).toBe(true);
  expect(startsGuide(null, true, 3)).toBe(false);
  expect(startsGuide(null, false, 0)).toBe(false);
  expect(startsGuide({ stage: "done" }, true, 0)).toBe(false);
});

test("the guide reaches the person's turn once a step of theirs holds, and is over only when nothing holds in the close", () => {
  expect(nextStage(started, guideEntry(facts({ tasks: 1, questions: 1 })), false)).toEqual({ stage: "turn", seen: [] });
  expect(nextStage(started, guideEntry(facts({ tasks: 1, working: 1 })), false)).toBeUndefined();
  expect(nextStage(turn, null, true)).toEqual({ stage: "done" });
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

test("a balloon told to stand clear of the box its part is in stands outside that box, its arrow still on the part", () => {
  const send = { left: 940, top: 846, width: 32, height: 32 }, foot = { left: 380, top: 655, width: 600, height: 235 };
  const size = { width: 496, height: 68 };
  const placed = placeBalloon(send, size, { width: 1360, height: 900 }, "top", "end", foot);
  expect(placed.y + size.height).toBeLessThanOrEqual(foot.top);
  expect(placed.x + placed.arrow).toBe(send.left + send.width / 2);
  const asked = { left: 887, top: 424, width: 432, height: 404 }, detail = { left: 832, top: 12, width: 516, height: 876 };
  const beside = placeBalloon(asked, size, { width: 1360, height: 900 }, "left", "start", detail);
  expect(beside.x + size.width).toBeLessThanOrEqual(detail.left);
  expect(beside.y).toBe(asked.top);
  // A detail taking the whole screen leaves no room round it: the balloon stands by the question, not over it.
  const view = { width: 1360, height: 900 };
  const over = placeBalloon(asked, size, view, "left", "start", { left: 0, top: 0, ...view });
  expect(over.x + size.width).toBeLessThanOrEqual(asked.left);
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

test("a row whose turn the person has already answered from here is not theirs, while it still stands in the list", () => {
  const rows = [{ taskId: "T1", section: "review" }, { taskId: "T2", section: "review" }];
  const task = (id: string) => ({ id, ball: { holder: "user", reason: "result" } }) as unknown as Task;
  const byId = new Map([["T1", task("T1")], ["T2", task("T2")]]);
  expect(awaiting(rows, byId, () => false, "T1")).toEqual({ questions: 0, results: 2, open: "result" });
  expect(awaiting(rows, byId, each => each.id === "T1", "T1")).toEqual({ questions: 0, results: 1, open: null });
});

test("Done pressed before the guide began (again) is not its own; Done pressed since is", () => {
  const again = { stage: "started", at: 9, seen: [], intro: true } as const;
  const first = doneSince(again, ["T1"], null);
  expect(first.fresh).toEqual([]);
  expect(doneSince(again, ["T1"], first).fresh).toEqual([]);
  const later = doneSince(turn, ["T1"], first);
  expect(later.fresh).toEqual([]);
  // Pressed while any step shows (words waiting to be sent, say): it is the guide's.
  expect(doneSince(turn, ["T1", "T5"], later).fresh).toEqual(["T5"]);
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
  // Taken back and put on hold: no step holds and the guide waits; awaiting again, Done is shown on it again.
  const held = facts({ stage: turn, tasks: 1, talked: true, doneHere: finishedHere(["T2"], states({ T2: "held" })).length > 0 });
  expect(guideEntry(held)).toBeNull();
  expect(nextStage(turn, guideEntry(held), held.doneHere)).toBeUndefined();
  expect(shown({ stage: turn, tasks: 1, talked: true, results: 1, open: "result", seen: read("more") })).toBe("accept");
});
