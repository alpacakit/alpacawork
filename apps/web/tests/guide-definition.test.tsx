import { expect, test } from "vitest";
import { PARTS, guideEntry, nextStage, startsGuide, type GuideFacts } from "../src/features/guide/guide-definition";
import { coordinatorFacts } from "../src/features/guide/use-guide";
import { placeBalloon } from "../src/features/guide/Guide";

const started = { stage: "started", at: 1, seen: [] } as const;
const turn = { stage: "turn", seen: [] } as const;
const facts = (over: Partial<GuideFacts>): GuideFacts =>
  ({ stage: started, tasks: 0, questions: 0, results: 0, working: 0, sent: false, busy: false, answered: false, welcome: false, drafting: false,
    answerDrafted: false, open: null, narrow: false, seen: new Set(), ...over });
const shown = (over: Partial<GuideFacts>) => guideEntry(facts(over))?.id ?? null;

test("from the empty welcome, a request sent moves the guide on to the AI's step and then to the person's turn", () => {
  expect(shown({ welcome: true })).toBe("send");
  expect(shown({ welcome: true, sent: true, busy: true })).toBe("received");
  expect(shown({ welcome: true, sent: true })).toBe("send");
  expect(shown({ tasks: 1, working: 1, sent: true })).toBe("working");
  expect(shown({ tasks: 1, questions: 1 })).toBe("question");
  expect(shown({ tasks: 1, results: 1 })).toBe("result");
});

test("on a phone's welcome no balloon stands over the examples: before a request, with one in the input, or once it is sent", () => {
  const narrow = { welcome: true, narrow: true };
  for (const over of [{}, { drafting: true }, { sent: true, busy: true }]) expect(guideEntry(facts({ ...narrow, ...over }))?.part).toBeUndefined();
  expect(guideEntry(facts({ ...narrow, sent: true, busy: true }))?.step).toBe(2);
});

test("with a report and a question both awaiting the person, the question's step points at the question's row", () => {
  document.body.innerHTML = '<li data-row-section="review" data-row-turn="result" id="report"></li><li data-row-section="review" data-row-turn="question" id="question"></li>';
  const entry = guideEntry(facts({ tasks: 2, questions: 1, results: 1 }));
  expect(entry?.id).toBe("question");
  expect(document.querySelector(PARTS[entry!.part!])?.id).toBe("question");
  expect(document.querySelector(PARTS.resultRow)?.id).toBe("report");
});

test("what is open in the detail comes before the list: its choices, or Done", () => {
  expect(shown({ tasks: 1, questions: 1, open: "question" })).toBe("answer");
  expect(shown({ tasks: 1, results: 1, open: "result" })).toBe("accept");
});

test("after the person's turn, work still going on is the AI's step; with none left the guide ends once read", () => {
  expect(shown({ stage: turn, tasks: 1, working: 1 })).toBe("working");
  expect(shown({ stage: turn, tasks: 1 })).toBe("end");
  expect(shown({ stage: turn, tasks: 1, seen: new Set(["end", "another-repository"]) })).toBeNull();
});

test("shown again over a list with nothing going on, the guide begins at sending a request", () => {
  expect(shown({ tasks: 4 })).toBe("send-again");
});

test("the guide starts by itself only for a new person: never stored, on the welcome, with no Task in the whole workspace", () => {
  expect(startsGuide(null, true, 0)).toBe(true);
  expect(startsGuide(null, true, 3)).toBe(false);
  expect(startsGuide(null, false, 0)).toBe(false);
  expect(startsGuide({ stage: "done" }, true, 0)).toBe(false);
});

test("the guide reaches the person's turn at the third step, and is over when nothing holds", () => {
  expect(nextStage(started, guideEntry(facts({ tasks: 1, questions: 1 })))).toEqual({ stage: "turn", seen: [] });
  expect(nextStage(started, guideEntry(facts({ tasks: 1, working: 1 })))).toBeUndefined();
  expect(nextStage(turn, null)).toEqual({ stage: "done" });
});

test("words waiting in the input point at sending them; an answer sent and still on its way is not the person's turn", () => {
  expect(shown({ drafting: true })).toBe("send-ready");
  expect(shown({ tasks: 1, questions: 1, open: "question", answerDrafted: true, drafting: true })).toBe("answer-ready");
  expect(shown({ tasks: 1, questions: 1, open: "question", answered: true })).toBe("answered");
  expect(shown({ tasks: 1, questions: 1, open: "question", busy: true })).toBe("answer");
});

test("an answer is with the coordinator only when a message carries one to a question still open, not while it works on another request", () => {
  const questions = new Set(["q1"]);
  const at = "2026-01-01T00:00:00Z";
  expect(coordinatorFacts({ since: null, sending: [], questions, turns: [{ id: "a", at, status: "running" }] }))
    .toEqual({ sent: false, busy: true, answered: false });
  expect(coordinatorFacts({ since: null, sending: [], questions, turns: [{ id: "a", at, status: "running", answers: [{ question: "q1" }] }] }).answered).toBe(true);
  expect(coordinatorFacts({ since: null, sending: [], questions, turns: [{ id: "a", at, status: "succeeded", answers: [{ question: "q1" }] }] }).answered).toBe(false);
  expect(coordinatorFacts({ since: null, turns: [], questions, sending: [{ requestId: "b", answers: [{ question: "q1" }] }] }).answered).toBe(true);
  expect(coordinatorFacts({ since: null, turns: [], questions, sending: [{ requestId: "b", answers: [{ question: "q2" }] }] }).answered).toBe(false);
});

test("shown again, a request sent while nothing is listed for it yet is received, not to be written again", () => {
  expect(shown({ tasks: 4, sent: true, busy: true })).toBe("received");
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
