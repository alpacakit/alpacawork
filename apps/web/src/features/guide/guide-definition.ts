import type { TFunction } from "i18next";
import type { GuideStage } from "./guide-state";

/**
 * The getting-started guide, in one place: which parts of the screen it can point at, and its steps in order.
 *
 * To add a step, add one entry to GUIDE where it belongs in the order and its words to tree.json (every language):
 * - `id`: its name (also what "Got it" remembers);
 * - `when`: the facts under which it holds; the first entry from the top that holds is the one shown;
 * - `part`, `side` and `align`: the part it points at (a name from PARTS), the side of that part its balloon stands on,
 *   and where along that side (middle unless said); without a part it has no balloon (the welcome's steps say it);
 * - `step`: which of the three STEPS it belongs to (1 send, 2 AI works, 3 your turn), shown in every balloon's head
 *   and as the welcome's current step; null for a step past the three;
 * - `next`: it waits for "Got it" before the guide goes on (put away once read);
 * - `say`: its words, by its key, written out so the extractor reads it.
 * Nothing else names a step: the balloon, the welcome and the stored stage read them from here.
 */

/**
 * The parts the guide points at, each by the data attribute the screen gives it (never a class, a place or a shape).
 * A part with no attribute of its own carries `data-guide-part="<name>"`.
 */
export const PARTS = {
  /** The box at the foot where requests are written: folded to one line, or open. */
  input: "[data-coordinator-capsule], [data-composer-frame]",
  /** Its send button, while there is something to send. */
  send: "[data-ask-send]:not(:disabled)",
  /** "Open conversation" over that box, which says what the coordinator is doing; pressed, it opens the conversation. */
  coordinator: "[data-coordinator-pill]",
  /** A list row of a Task being worked on or about to be. */
  workingRow: '[data-row-section="doing"], [data-row-section="todo"], [data-row-section="awaited"]',
  /** A list row awaiting the person. */
  turnRow: '[data-row-section="review"]',
  /** An open question's choices, in the detail. */
  choices: '[data-guide-part="answer-choices"]',
  /** Done, which accepts a report (a word on a computer, a mark on a phone). */
  finish: "[data-task-done]",
} as const;
export type GuidePart = keyof typeof PARTS;
export type GuideSide = "top" | "bottom" | "left" | "right";
/** Where along the part the balloon lines up: its middle, or its start or end (clear of what stands at the other end). */
export type GuideAlign = "start" | "middle" | "end";

/** What the guide reads to choose its step: all of it already on the screen (use-guide.ts gathers it). */
export type GuideFacts = {
  /** This browser's stage; never "done" here (a guide that is over shows nothing). */
  stage: Exclude<GuideStage, { stage: "done" }>;
  /** The Tasks in the scope in view (none: its welcome is shown). */
  tasks: number;
  /** Rows awaiting the person: asking a question, or bringing a result. */
  questions: number; results: number;
  /** Rows still being worked on or about to be (In progress, Not started, Waiting). */
  working: number;
  /** A request went to the coordinator after the guide started. */
  sent: boolean;
  /** The coordinator is still on what the person sent (about to send, handing over, or working on it). */
  busy: boolean;
  /** The input holds something to send; and, among it, an answer to the Task open in the detail. */
  drafting: boolean; answerDrafted: boolean;
  /** The Task open in the detail, when it is the person's turn on it. */
  open: "question" | "result" | null;
  /** Steps put away with "Got it". */
  seen: ReadonlySet<string>;
};

export type GuideEntry = {
  id: string;
  when: (facts: GuideFacts) => boolean;
  part?: GuidePart;
  side?: GuideSide;
  align?: GuideAlign;
  step: 1 | 2 | 3 | null;
  next?: boolean;
  say: (t: TFunction) => string;
};

/** The three steps the guide walks through: their names (said in every balloon's head) and what each is about. */
export const STEPS = {
  1: { title: (t: TFunction) => t("tree:guide.steps.send.title"),
    detail: (t: TFunction) => t("tree:guide.steps.send.detail", { input: t("ui:input.placeholderFolded") }) },
  2: { title: (t: TFunction) => t("tree:guide.steps.work.title"), detail: (t: TFunction) => t("tree:guide.steps.work.detail") },
  3: { title: (t: TFunction) => t("tree:guide.steps.turn.title"), detail: (t: TFunction) => t("tree:guide.steps.turn.detail") },
} as const;

const turnSection = (t: TFunction) => t("tree:home.turn");
const finish = (t: TFunction) => t("ui:coordinatorCard.done");

export const GUIDE: readonly GuideEntry[] = [
  // The person's turn, from the most immediate: an answer ready to send, one sent and on its way, then what is open.
  { id: "answer-ready", step: 3, part: "send", side: "top", when: f => f.open === "question" && f.answerDrafted,
    say: t => t("tree:guide.say.answerReady") },
  { id: "answered", step: 3, part: "coordinator", side: "top", when: f => f.questions > 0 && f.busy,
    say: t => t("tree:guide.say.answered") },
  { id: "answer", step: 3, part: "choices", side: "top", when: f => f.open === "question",
    say: t => t("tree:guide.say.answer") },
  { id: "accept", step: 3, part: "finish", side: "top", when: f => f.open === "result",
    say: t => t("tree:guide.say.accept", { files: t("reader:entries.files"), finish: finish(t) }) },
  { id: "question", step: 3, part: "turnRow", side: "bottom", when: f => f.questions > 0,
    say: t => t("tree:guide.say.question") },
  { id: "result", step: 3, part: "turnRow", side: "bottom", when: f => f.results > 0,
    say: t => t("tree:guide.say.result") },
  { id: "working", step: 2, part: "workingRow", side: "bottom", when: f => f.working > 0,
    say: t => t("tree:guide.say.working", { section: turnSection(t) }) },
  // A request sent and the coordinator still on it, with no Task for it yet. Answered without one, the guide goes back to
  // sending a request.
  { id: "received", step: 2, part: "coordinator", side: "top", when: f => f.sent && f.busy,
    say: t => t("tree:guide.say.received") },
  // Once the person has had their turn and nothing is left to bring them a report, the guide closes.
  { id: "end", align: "end", step: null, part: "input", side: "top", next: true, when: f => f.stage.stage === "turn" && !f.seen.has("end"),
    say: t => t("tree:guide.say.end") },
  // Before any turn: words in the input wait to be sent...
  { id: "send-ready", step: 1, part: "send", side: "top", when: f => f.stage.stage === "started" && f.drafting,
    say: t => t("tree:guide.say.sendReady") },
  // ...or a request is to be written, from the empty welcome with its examples above...
  { id: "send", align: "end", step: 1, part: "input", side: "top", when: f => f.stage.stage === "started" && f.tasks === 0,
    say: t => t("tree:guide.say.send") },
  // ...or, shown again from settings, over a list with nothing going on.
  { id: "send-again", align: "end", step: 1, part: "input", side: "top", when: f => f.stage.stage === "started",
    say: t => t("tree:guide.say.sendAgain") },
];

/** The step shown: the first entry from the top whose facts hold; none when none does (the guide is over). */
export const guideEntry = (facts: GuideFacts): GuideEntry | null => GUIDE.find(entry => entry.when(facts)) ?? null;

/**
 * The stage to store as the guide moves: started on an empty welcome seen for the first time; the person's turn once a
 * step of the third holds; over once no step holds. Undefined: nothing to store.
 */
export function nextStage(stage: GuideStage | null, welcome: boolean, entry: GuideEntry | null, now = Date.now()): GuideStage | undefined {
  if (!stage) return welcome ? { stage: "started", at: now, seen: [] } : undefined;
  if (stage.stage === "done") return undefined;
  if (!entry) return { stage: "done" };
  return stage.stage === "started" && entry.step === 3 ? { stage: "turn", seen: stage.seen } : undefined;
}
