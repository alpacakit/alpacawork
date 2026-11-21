import { expect, test } from "vitest";
import { guideEntry, nextStage, type GuideFacts } from "../src/features/guide/guide-definition";

const started = { stage: "started", at: 1, seen: [] } as const;
const turn = { stage: "turn", seen: [] } as const;
const facts = (over: Partial<GuideFacts>): GuideFacts =>
  ({ stage: started, tasks: 0, questions: 0, results: 0, working: 0, sent: false, busy: false, drafting: false, answerDrafted: false, open: null, seen: new Set(), ...over });
const shown = (over: Partial<GuideFacts>) => guideEntry(facts(over))?.id ?? null;

test("from the empty welcome, a request sent moves the guide on to the AI's step and then to the person's turn", () => {
  expect(shown({})).toBe("send");
  expect(shown({ sent: true, busy: true })).toBe("received");
  expect(shown({ sent: true })).toBe("send");
  expect(shown({ tasks: 1, working: 1, sent: true })).toBe("working");
  expect(shown({ tasks: 1, questions: 1 })).toBe("question");
  expect(shown({ tasks: 1, results: 1 })).toBe("result");
});

test("what is open in the detail comes before the list: its choices, or Done", () => {
  expect(shown({ tasks: 1, questions: 1, open: "question" })).toBe("answer");
  expect(shown({ tasks: 1, results: 1, open: "result" })).toBe("accept");
});

test("after the person's turn, work still going on is the AI's step; with none left the guide ends once read", () => {
  expect(shown({ stage: turn, tasks: 1, working: 1 })).toBe("working");
  expect(shown({ stage: turn, tasks: 1 })).toBe("end");
  expect(shown({ stage: turn, tasks: 1, seen: new Set(["end"]) })).toBeNull();
});

test("shown again over a list with nothing going on, the guide begins at sending a request", () => {
  expect(shown({ tasks: 4 })).toBe("send-again");
});

test("the guide starts only on an empty welcome, reaches the person's turn at the third step, and is over when nothing holds", () => {
  expect(nextStage(null, true, null, 5)).toEqual({ stage: "started", at: 5, seen: [] });
  expect(nextStage(null, false, null)).toBeUndefined();
  expect(nextStage(started, false, guideEntry(facts({ tasks: 1, questions: 1 })))).toEqual({ stage: "turn", seen: [] });
  expect(nextStage(started, false, guideEntry(facts({ tasks: 1, working: 1 })))).toBeUndefined();
  expect(nextStage(turn, false, null)).toEqual({ stage: "done" });
  expect(nextStage({ stage: "done" }, true, null)).toBeUndefined();
});

test("words waiting in the input point at sending them; an answer sent and still on its way is not the person's turn", () => {
  expect(shown({ drafting: true })).toBe("send-ready");
  expect(shown({ tasks: 1, questions: 1, open: "question", answerDrafted: true, drafting: true })).toBe("answer-ready");
  expect(shown({ tasks: 1, questions: 1, open: "question", busy: true })).toBe("answered");
});

test("shown again, a request sent while nothing is listed for it yet is received, not to be written again", () => {
  expect(shown({ tasks: 4, sent: true, busy: true })).toBe("received");
});
