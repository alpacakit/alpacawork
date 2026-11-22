import { expect, test } from "vitest";
import { PARTS, doneOnLeaving, guideEntry, nextStage, startsGuide, type GuideFacts } from "../src/features/guide/guide-definition";
import { coordinatorFacts, foundDraft } from "../src/features/guide/use-guide";
import { placeBalloon } from "../src/features/guide/Guide";

const started = { stage: "started", at: 1, seen: [] } as const;
const turn = { stage: "turn", seen: [] } as const;
const facts = (over: Partial<GuideFacts>): GuideFacts =>
  ({ stage: started, tasks: 0, questions: 0, results: 0, working: 0, unowned: 0, labelled: false, sent: false, busy: false, drafting: false,
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
  // Answered with no Task, the guide goes back to writing a request.
  expect(shown({ sent: true })).toBe("send-again");
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
  expect(shown({ ...report, seen: read("more"), drafting: true, labelled: true })).toBe("label");
  expect(shown({ ...report, seen: read("more"), drafting: true })).toBe("accept");
  expect(shown({ ...report, seen: read("more", "label"), drafting: true, labelled: true })).toBe("accept");
});

test("a step shown once with no button is done when the guide moves on from it; one with a button only by it", () => {
  const entry = (over: Partial<GuideFacts>) => guideEntry(facts(over));
  const label = entry({ stage: turn, tasks: 1, results: 1, open: "result", seen: read("more"), drafting: true, labelled: true });
  const accept = entry({ stage: turn, tasks: 1, results: 1, open: "result", seen: read("more") });
  expect(doneOnLeaving(label, accept)).toBe(true);
  expect(doneOnLeaving(label, label)).toBe(false);
  expect(doneOnLeaving(entry({ stage: turn, tasks: 1, results: 1, open: "result" }), accept)).toBe(false);
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

test("once the person has had their turn and nothing is going on, the guide closes in steps read once each", () => {
  expect(shown({ stage: turn, tasks: 1, working: 1 })).toBe("working");
  expect(shown({ stage: turn, tasks: 1 })).toBe("end");
  expect(shown({ stage: turn, tasks: 1, seen: read("end") })).toBe("another-repository");
  expect(shown({ stage: turn, tasks: 1, seen: read("end", "another-repository") })).toBeNull();
  // Where settings hold the steps to the installed app and the phone, pointing at them once is the last step.
  expect(shown({ stage: turn, tasks: 1, apps: true, seen: read("end", "another-repository") })).toBe("apps");
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

test("the guide reaches the person's turn once a step of theirs holds, and is over when nothing holds", () => {
  expect(nextStage(started, guideEntry(facts({ tasks: 1, questions: 1 })))).toEqual({ stage: "turn", seen: [] });
  expect(nextStage(started, guideEntry(facts({ tasks: 1, working: 1 })))).toBeUndefined();
  expect(nextStage(turn, null)).toEqual({ stage: "done" });
});

test("the coordinator is busy while anything sent is still with it, and a request is the guide's once sent after it began", () => {
  const at = "2026-01-01T00:00:00Z";
  expect(coordinatorFacts({ since: null, sending: [], turns: [{ id: "a", at, status: "running" }] })).toEqual({ sent: false, busy: true });
  expect(coordinatorFacts({ since: null, sending: ["b"], turns: [] }).busy).toBe(true);
  expect(coordinatorFacts({ since: Date.parse(at), sending: [], turns: [{ id: "a", at, status: "succeeded" }] })).toEqual({ sent: true, busy: false });
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
  expect(nextStage(intro, guideEntry(facts({ stage: intro, tasks: 4, questions: 1 })))).toBeUndefined();
  expect(nextStage(intro, guideEntry(facts({ stage: intro, tasks: 4, drafting: true })))).toEqual({ stage: "started", at: 1, seen: [] });
  expect(nextStage(intro, guideEntry(facts({ stage: intro, tasks: 4, sent: true, busy: true })))).toEqual({ stage: "started", at: 1, seen: [] });
});

test("shown again, what the input already held is not writing; a change to it is", () => {
  const intro = { stage: "started", at: 5, seen: [], intro: true } as const;
  const found = foundDraft(intro, "old words", null);
  expect(found?.same).toBe(true);
  expect(foundDraft(intro, "old words", found)?.same).toBe(true);
  expect(foundDraft(intro, "old words and more", found)?.same).toBe(false);
  expect(foundDraft(started, "old words", found)).toBeNull();
});
