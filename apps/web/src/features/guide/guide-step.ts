import { deviceValue, jsonCodec } from "@/lib/device-storage";

/**
 * How far this browser is through the getting-started guide: started (at the moment it began, so a request sent
 * afterwards is known as this guide's first one), got as far as the person's turn, or over (finished or closed).
 * Nothing stored is a browser that has never seen it.
 */
export type GuideStage = { stage: "started"; at: number } | { stage: "turn" } | { stage: "done" };

const check = (value: unknown): GuideStage | null => {
  if (typeof value !== "object" || value === null) return null;
  const { stage, at } = value as { stage?: unknown; at?: unknown };
  if (stage === "started" && typeof at === "number") return { stage, at };
  return stage === "turn" || stage === "done" ? { stage } : null;
};
export const guideStage = deviceValue<GuideStage | null>("alpacawork.guide", jsonCodec<GuideStage | null>(check), null);
/** Ends the guide for good on this browser: closed by hand, or read to its end. */
export const closeGuide = () => { guideStage.set({ stage: "done" }); };
/** Settings' "Show again": the guide starts over from its first step. */
export const restartGuide = () => { guideStage.set({ stage: "started", at: Date.now() }); };

export type GuideFacts = {
  stage: GuideStage | null;
  /** The Tasks in the scope in view (none: its welcome is shown). */
  tasks: number;
  /** Rows awaiting the person: asking a question, or bringing a result. */
  questions: number; results: number;
  /** Rows still being worked on or about to be (In progress, Not started, Waiting). */
  working: number;
  /** A request went to the coordinator after the guide started. */
  sent: boolean;
};
/**
 * Where the guide stands: its step (1 send, 2 AI works, 3 your turn, 4 all done), what it says there, and the stage to
 * store when this moment moves it on. Null: nothing is shown. Read from the data alone, never from where things are on
 * the screen, so the same facts always give the same step.
 */
export type GuideStep = {
  step: 1 | 2 | 3 | 4;
  say: "send" | "received" | "working" | "question" | "result" | "end";
  store?: GuideStage;
};

export function guideStep({ stage, tasks, questions, results, working, sent }: GuideFacts, now = Date.now()): GuideStep | null {
  if (stage?.stage === "done") return null;
  // It starts only on an empty scope's welcome: a person already at work never meets it.
  if (!stage) return tasks === 0 ? { step: 1, say: "send", store: { stage: "started", at: now } } : null;
  if (tasks === 0) return sent ? { step: 2, say: "received" } : { step: 1, say: "send" };
  const turn: GuideStage | undefined = stage.stage === "turn" ? undefined : { stage: "turn" };
  if (questions > 0) return { step: 3, say: "question", store: turn };
  if (results > 0) return { step: 3, say: "result", store: turn };
  if (working > 0) return { step: 2, say: "working" };
  // After the person's turn the guide is over once no work is left to bring them a result; started again over a list
  // with nothing going on (settings' "Show again"), it begins at sending a request.
  return stage.stage === "turn" ? { step: 4, say: "end" } : { step: 1, say: "send" };
}
