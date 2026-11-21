import type { TFunction } from "i18next";
import { userTurn } from "@alpacawork/contract";
import type { Task } from "@/data/types";
import { finishAppHint } from "@/features/coordinator/app-hint";
import { openSettings } from "@/state/dialog-store";
import type { GuideStage } from "./guide-state";

/**
 * The getting-started guide, in one place: which parts of the screen it can point at, and its steps in order.
 *
 * To add a step, add one entry to GUIDE where it belongs in the order and its words to tree.json (every language):
 * - `id`: its name (also what "Got it" remembers);
 * - `when`: the facts under which it holds; the first entry from the top that holds is the one shown;
 * - `part`, `side` and `align`: the part it points at (a name from PARTS), the side of that part its balloon stands on,
 *   and where along that side (middle unless said); without a part it has no balloon (the welcome's steps say it);
 * - `clear`: a part holding the one pointed at, whose whole the balloon stands clear of (what is read there stays read);
 * - `step`: which of the three STEPS it belongs to (1 send, 2 AI works, 3 your turn), shown in every balloon's head
 *   and as the welcome's current step; null for a step past the three;
 * - `next`: it waits for "Got it" before the guide goes on (put away once read); `more` with it: another step follows
 *   straight after, so its button says "Next";
 * - `action`: one thing the step offers to do from its balloon (its button's words and what it does); doing it puts
 *   the step away;
 * - `settle`: what putting the step away also settles elsewhere (a pointer that says the same thing, say);
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
  /** The foot that box stands in, open or folded (the row of buttons over it stands outside it). */
  foot: "[data-coordinator-card]",
  /** Its send button, while there is something to send. */
  send: "[data-ask-send]:not(:disabled)",
  /**
   * "Open conversation" over that box, which says what the coordinator is doing; pressed, it opens the conversation.
   * Not what stands there while a message can still be taken back ("about to send"): it says the message is not sent yet.
   */
  coordinator: "[data-coordinator-pill][data-coordinator-expand]",
  /** A list row of a Task being worked on or about to be. */
  workingRow: '[data-row-section="doing"], [data-row-section="todo"], [data-row-section="awaited"]',
  /** A list row awaiting the person's answer to a question. */
  questionRow: '[data-row-turn="question"]',
  /** A list row awaiting the person for anything else: a report, mostly. */
  resultRow: '[data-row-turn="result"]',
  /** The detail beside the list, where an open Task is read. */
  detail: "aside[data-reader-mode]",
  /** An open question in the detail: its number, what it asks and its choices (the first, when several are asked). */
  asked: "[data-waiting-report-actions] [data-question]",
  /** Done, which accepts a report (a word on a computer, a mark on a phone), once it can be pressed. */
  finish: "[data-task-done]:not(:disabled)",
  /** The project's name at the top left, which opens the projects' menu. */
  project: "[data-project-trigger]",
  /** The settings' button at the top right. */
  settings: '[data-guide-part="settings"]',
} as const;
export type GuidePart = keyof typeof PARTS;
/** What a row awaiting the person awaits (its `data-row-turn`): an answer to a question, or anything else (a report). */
export const turnKind = (task: Pick<Task, "ball">): "question" | "result" => userTurn(task.ball)?.reason === "question" ? "question" : "result";
export type GuideSide = "top" | "bottom" | "left" | "right";
/** Where along the part the balloon lines up: its middle, or its start or end (clear of what stands at the other end). */
export type GuideAlign = "start" | "middle" | "end";

/**
 * What the guide reads to choose its step: all of it already on the screen (use-guide.ts gathers it). The work is
 * counted across the whole workspace, not the project in view, so a step says what is so wherever the person looks; a
 * step whose part is not on the screen just shows no balloon.
 */
export type GuideFacts = {
  /** This browser's stage; never "done" here (a guide that is over shows nothing). */
  stage: Exclude<GuideStage, { stage: "done" }>;
  /** The Tasks in the workspace. */
  tasks: number;
  /** Rows awaiting the person, in the workspace: asking a question, or bringing a result. */
  questions: number; results: number;
  /** Rows still being worked on or about to be, in the workspace (In progress, Not started, Waiting). */
  working: number;
  /** Among them, rows not started with no AI put on them: nothing goes on there until the person says what to do. */
  unowned: number;
  /** A request went to the coordinator after the guide started. */
  sent: boolean;
  /** The coordinator is still on what the person sent (about to send, handing over, or working on it). */
  busy: boolean;
  /** An answer the person sent to a question still open is with the coordinator (about to send, or being worked on). */
  answered: boolean;
  /** The list's place is an empty scope's welcome (its three steps say where the guide is). */
  welcome: boolean;
  /** The input holds something to send; and, among it, an answer to the Task open in the detail. */
  drafting: boolean; answerDrafted: boolean;
  /** The Task open in the detail, when it is the person's turn on it. */
  open: "question" | "result" | null;
  /** A phone's width, where a balloon takes most of the screen across. */
  narrow: boolean;
  /** Settings hold the guide to the installed app and the phone here (not on a touch screen, not in the installed app). */
  apps: boolean;
  /** Steps put away with "Got it". */
  seen: ReadonlySet<string>;
};

export type GuideEntry = {
  id: string;
  when: (facts: GuideFacts) => boolean;
  part?: GuidePart;
  clear?: GuidePart;
  side?: GuideSide;
  align?: GuideAlign;
  step: 1 | 2 | 3 | null;
  next?: boolean;
  more?: boolean;
  action?: { label: (t: TFunction) => string; run: () => void };
  settle?: () => void;
  say: (t: TFunction) => string;
};

/** The three steps the guide walks through: their names (said in every balloon's head) and what each is about. */
export const STEPS = {
  1: { title: (t: TFunction) => t("tree:guide.steps.send.title"),
    detail: (t: TFunction) => t("tree:guide.steps.send.detail") },
  2: { title: (t: TFunction) => t("tree:guide.steps.work.title"), detail: (t: TFunction) => t("tree:guide.steps.work.detail") },
  3: { title: (t: TFunction) => t("tree:guide.steps.turn.title"), detail: (t: TFunction) => t("tree:guide.steps.turn.detail") },
} as const;

const turnSection = (t: TFunction) => t("tree:home.turn");
/** Before anything is sent or written, on a screen wide enough for a balloon: the parts are shown first, one by one. */
const touring = (f: GuideFacts, id: string) => f.stage.stage === "started" && !f.sent && !f.drafting && !f.narrow && !f.seen.has(id);
const finish = (t: TFunction) => t("ui:coordinatorCard.done");

export const GUIDE: readonly GuideEntry[] = [
  // The person's turn, from the most immediate: an answer ready to send, one sent and on its way, then what is open.
  { id: "answer-ready", step: 3, part: "send", clear: "foot", side: "top", align: "end", when: f => f.open === "question" && f.answerDrafted,
    say: t => t("tree:guide.say.answerReady") },
  { id: "answered", step: 3, part: "coordinator", side: "top", when: f => f.answered,
    say: t => t("tree:guide.say.answered") },
  { id: "answer", step: 3, part: "asked", clear: "detail", side: "left", align: "start", when: f => f.open === "question",
    say: t => t("tree:guide.say.answer") },
  { id: "accept", step: 3, part: "finish", side: "top", align: "end", when: f => f.open === "result",
    say: t => t("tree:guide.say.accept", { files: t("reader:entries.files"), finish: finish(t) }) },
  { id: "question", step: 3, part: "questionRow", side: "bottom", when: f => f.questions > 0,
    say: t => t("tree:guide.say.question") },
  { id: "result", step: 3, part: "resultRow", side: "bottom", when: f => f.results > 0,
    say: t => t("tree:guide.say.result") },
  // First, the parts a request passes through, on any screen (they are always there): the input with the label that
  // says where a message goes, then the coordinator. Read one by one, or passed over by starting to write.
  { id: "tour-input", step: 1, part: "input", side: "top", align: "end", next: true, more: true, when: f => touring(f, "tour-input"),
    say: t => t("tree:guide.say.tourInput") },
  { id: "tour-coordinator", step: 1, part: "coordinator", side: "top", align: "start", next: true, more: true, when: f => touring(f, "tour-coordinator"),
    say: t => t("tree:guide.say.tourCoordinator") },
  // A Task made with no AI on it waits for the person: nothing there is the AI's yet.
  { id: "unassigned", step: 1, part: "workingRow", side: "bottom", when: f => f.working > 0 && f.unowned === f.working,
    say: t => t("tree:guide.say.unassigned") },
  { id: "working", step: 2, part: "workingRow", side: "bottom", when: f => f.working > 0,
    say: t => t("tree:guide.say.working", { section: turnSection(t) }) },
  // A request sent and the coordinator still on it, with no Task for it yet (on a phone's welcome, its steps say it: a
  // balloon there would stand over the examples). Answered without one, the guide goes back to sending a request.
  { id: "received-welcome-narrow", step: 2, when: f => f.sent && f.busy && f.welcome && f.narrow,
    say: t => t("tree:guide.say.received") },
  { id: "received", step: 2, part: "coordinator", side: "top", when: f => f.sent && f.busy,
    say: t => t("tree:guide.say.received") },
  // Once the person has had their turn and nothing is left to bring them a report, the guide closes.
  { id: "end", align: "end", step: null, part: "input", side: "top", next: true, when: f => f.stage.stage === "turn" && !f.seen.has("end"),
    say: t => t("tree:guide.say.end") },
  // After the end: where another repository is taken on.
  { id: "another-repository", step: null, part: "project", side: "right", align: "start", next: true,
    when: f => f.stage.stage === "turn" && !f.seen.has("another-repository"),
    say: t => t("tree:guide.say.anotherRepository", { create: t("chrome:projects.new") }) },
  // Last, once: alpacawork as an installed app and from a phone, where settings hold the steps. Read here, the first
  // screen's pointer to the same steps is done with.
  { id: "apps", step: null, part: "settings", side: "bottom", align: "end", next: true, settle: finishAppHint,
    action: { label: t => t("tree:guide.openSteps"), run: () => openSettings("apps") },
    when: f => f.stage.stage === "turn" && f.apps && !f.narrow && !f.seen.has("apps"),
    say: t => t("tree:guide.say.apps", { settings: t("chrome:appBar.settings"), apps: t("panels:settings.tabs.apps") }) },
  // Before any turn, on a phone's welcome, its steps say it all, words in the input or not: a balloon there would stand
  // over the examples...
  { id: "send-welcome-narrow", step: 1, when: f => f.stage.stage === "started" && f.welcome && f.narrow,
    say: t => t("tree:guide.say.send") },
  // ...elsewhere, words in the input wait to be sent...
  { id: "send-ready", step: 1, part: "send", clear: "foot", side: "top", align: "end", when: f => f.stage.stage === "started" && f.drafting,
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
 * Whether the guide starts by itself: on a browser that has never had it, with the welcome on the screen and no Task in
 * the whole workspace (a new person's first look; not someone with work elsewhere opening an empty project).
 */
export const startsGuide = (stage: GuideStage | null, welcome: boolean, tasks: number) => stage === null && welcome && tasks === 0;

/**
 * The stage to store as a guide going on moves: the person's turn once a step of the third holds; over once no step
 * holds. Undefined: nothing to store.
 */
export function nextStage(stage: Exclude<GuideStage, { stage: "done" }>, entry: GuideEntry | null): GuideStage | undefined {
  if (!entry) return { stage: "done" };
  return stage.stage === "started" && entry.step === 3 ? { stage: "turn", seen: stage.seen } : undefined;
}
