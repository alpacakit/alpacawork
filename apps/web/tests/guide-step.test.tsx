import { expect, test } from "vitest";
import { guideStep, type GuideFacts } from "../src/features/guide/guide-step";

const facts = (over: Partial<GuideFacts>): GuideFacts => ({ stage: { stage: "started", at: 1 }, tasks: 0, questions: 0, results: 0, working: 0, sent: false, ...over });

test("the guide starts only on an empty scope, never for a person already at work, and never again once over", () => {
  expect(guideStep(facts({ stage: null }), 5)).toEqual({ step: 1, say: "send", store: { stage: "started", at: 5 } });
  expect(guideStep(facts({ stage: null, tasks: 3, questions: 1 }))).toBeNull();
  expect(guideStep(facts({ stage: { stage: "done" } }))).toBeNull();
  expect(guideStep(facts({ stage: { stage: "done" }, tasks: 1, results: 1 }))).toBeNull();
});

test("a request sent before its Task is listed moves the guide to the AI's step", () => {
  expect(guideStep(facts({}))).toEqual({ step: 1, say: "send" });
  expect(guideStep(facts({ sent: true }))).toEqual({ step: 2, say: "received" });
  expect(guideStep(facts({ tasks: 1, working: 1, sent: true }))).toEqual({ step: 2, say: "working" });
});

test("a question or a result is the person's turn, stored once; after it, the guide ends once nothing awaits them or is worked on", () => {
  expect(guideStep(facts({ tasks: 1, questions: 1, results: 1 }))).toEqual({ step: 3, say: "question", store: { stage: "turn" } });
  expect(guideStep(facts({ tasks: 1, results: 1 }))).toEqual({ step: 3, say: "result", store: { stage: "turn" } });
  expect(guideStep(facts({ stage: { stage: "turn" }, tasks: 1, results: 1 }))).toEqual({ step: 3, say: "result" });
  expect(guideStep(facts({ stage: { stage: "turn" }, tasks: 1, working: 1 }))).toEqual({ step: 2, say: "working" });
  expect(guideStep(facts({ stage: { stage: "turn" }, tasks: 1 }))).toEqual({ step: 4, say: "end" });
});

test("shown again over a list with nothing going on, the guide begins at sending a request", () => {
  expect(guideStep(facts({ tasks: 4 }))).toEqual({ step: 1, say: "send" });
});
