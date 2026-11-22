import type { TFunction } from "i18next";
import { userTurn } from "@alpacawork/contract";
import type { Task } from "@/data/types";
import { exampleInDraft } from "@/features/coordinator/editor/draft";
import { openSettings } from "@/state/dialog-store";
import type { GuideStage } from "./guide-state";

/**
 * The getting-started guide, in one place: which parts of the screen it can point at, and its steps in order.
 *
 * To add a step, add one entry to GUIDE where it belongs in the order and its words to tree.json (every language):
 * - `id`: its name (also what "Got it" remembers);
 * - `when`: the facts under which it holds; the first entry from the top that holds is the one shown;
 * - `part`, `side` and `align`: the part it points at (a name from PARTS), the side of that part its balloon stands on,
 *   and where along that side (middle unless said);
 * - `clear`: parts the balloon stands clear of, whole (what is read there stays read): the one holding the part pointed
 *   at, or one standing beside it (the first of its kind seen);
 * - `turn`: it is the person's turn (a question or a report awaits them); once one holds, the guide is past sending;
 * - `once`: it is shown once: put away by its button, or once the guide moves on from it (doneOnLeaving);
 * - `next`: it waits for "Got it" before the guide goes on (put away once read);
 * - `action`: one thing the step offers to do from its balloon (its button's words and what it does); doing it puts
 *   the step away;
 * - `say`: its words, by its key, written out so the extractor reads it.
 * Nothing else names a step: the balloon and the stored stage read them from here.
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
  /** The conversation with the coordinator: that button while it is folded, its "Clear conversation" while it is open. */
  conversation: "[data-coordinator-pill][data-coordinator-expand], [data-coordinator-clear]",
  /** The open conversation's own panel, over the foot. */
  panel: "[data-coordinator-panel]",
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
  /** Change state in the detail, where a Task (and the AI on it) is stopped. */
  taskState: "[data-task-state]:not(:disabled)",
  /** A label in that box, at its left end: the project or Task a message goes to. */
  label: ":is([data-coordinator-capsule], [data-composer-frame]) [data-label=task]",
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
  /** The input holds a label (a project's or a Task's). */
  labelled: boolean;
  /** Tasks finished in the workspace. */
  finished: number;
  /** The conversation with the coordinator holds messages (it has not been cleared). */
  talked: boolean;
  /** The latest message to the coordinator was answered in the conversation itself, writing to no Task. */
  direct: boolean;
  /** A request went to the coordinator after the guide started. */
  sent: boolean;
  /** The coordinator is still on what the person sent (about to send, handing over, or working on it). */
  busy: boolean;
  /** The input holds something to send (written since the first screen was shown again, while it is). */
  drafting: boolean;
  /** The Task seen in the detail: the person's turn on it (a question, or anything else), or being worked on. */
  open: "question" | "result" | "working" | null;
  /** A phone's width. */
  narrow: boolean;
  /** Settings hold the guide to the installed app and the phone here (not on a touch screen). */
  apps: boolean;
  /** Steps put away (by their button, or left: `once`). */
  seen: ReadonlySet<string>;
};

export type GuideEntry = {
  id: string;
  when: (facts: GuideFacts) => boolean;
  part?: GuidePart;
  clear?: readonly GuidePart[];
  side?: GuideSide;
  align?: GuideAlign;
  turn?: boolean;
  once?: boolean;
  next?: boolean;
  action?: { label: (t: TFunction) => string; run: (t: TFunction) => void };
  say: (t: TFunction) => string;
};

const turnSection = (t: TFunction) => t("tree:home.turn");
const finish = (t: TFunction) => t("ui:coordinatorCard.done");
/**
 * Every step at the input stands clear of the foot, the conversation's button beside it and, while it is open, the
 * conversation's panel: what is read there stays read.
 */
const AT_INPUT = { clear: ["foot", "coordinator", "panel"], side: "top" } as const;
/** Steps at the conversation itself stand clear of the foot and, while it is open, its panel. */
const AT_CONVERSATION = { clear: ["foot", "panel"], side: "top", align: "start" } as const;
/** Once the person has finished a Task of theirs and nothing else is theirs to do. */
const pastFirst = (f: GuideFacts) => f.stage.stage === "turn" && f.finished > 0;

export const GUIDE: readonly GuideEntry[] = [
  // The first screen (or it shown again), before anything is written or sent: the one input there is, and a request
  // to try the whole flow with.
  { id: "send", part: "input", ...AT_INPUT, align: "end",
    when: f => f.stage.stage === "started" && !f.drafting && !f.sent && (f.tasks === 0 || !!f.stage.intro),
    action: { label: t => t("tree:guide.tryExample"), run: t => exampleInDraft(t("tree:guide.example")) },
    say: t => t("tree:guide.say.send") },
  // Whatever was sent (a request, an answer, one more), while the coordinator is still on it.
  { id: "received", part: "coordinator", side: "top", when: f => f.busy,
    say: t => t("tree:guide.say.received") },
  // What is open in the detail: a question, until its answer is sent...
  { id: "answer", turn: true, part: "asked", clear: ["detail"], side: "left", align: "start", when: f => f.open === "question",
    say: t => t("tree:guide.say.answer") },
  // ...a report: first, that more can be asked after it (with one more to try), then the label that goes with what is
  // written (not on a phone's width, where a balloon over the input stands over the report itself)...
  { id: "more", turn: true, once: true, part: "input", ...AT_INPUT, align: "end", next: true, when: f => f.open === "result" && !f.narrow,
    action: { label: t => t("tree:guide.tryExample"), run: t => exampleInDraft(t("tree:guide.moreExample")) },
    say: t => t("tree:guide.say.more") },
  { id: "label", turn: true, once: true, part: "label", ...AT_INPUT, align: "start",
    when: f => f.open === "result" && f.drafting && f.labelled && f.seen.has("more") && !f.narrow,
    say: t => t("tree:guide.say.label") },
  // Words in the input, wherever the guide is: they wait to be sent.
  { id: "send-ready", part: "send", ...AT_INPUT, align: "end", when: f => f.drafting,
    say: t => t("tree:guide.say.sendReady") },
  // ...then Done on the report...
  { id: "accept", turn: true, part: "finish", side: "top", align: "end", when: f => f.open === "result",
    say: t => t("tree:guide.say.accept", { finish: finish(t) }) },
  // ...or, on a Task being worked on, where the AI on it is stopped.
  { id: "stop", once: true, part: "taskState", side: "top", align: "end", next: true, when: f => f.open === "working",
    say: t => t("tree:guide.say.stop", { stop: t("forms:reportForm.stopTitle") }) },
  // Then the rows awaiting the person, the question first.
  { id: "question", turn: true, part: "questionRow", side: "bottom", when: f => f.questions > 0,
    say: t => t("tree:guide.say.question") },
  { id: "result", turn: true, part: "resultRow", side: "bottom", when: f => f.results > 0,
    say: t => t("tree:guide.say.result") },
  // Once a Task of theirs is finished, before other work going on: the conversation with the coordinator is for
  // throwing away (what is to be kept goes into a Task; cleared, the step is done); where another repository is
  // taken on; and last, where settings hold the steps to answering from a phone (installing the app is asked once, as
  // setup ends).
  { id: "conversation", once: true, part: "conversation", ...AT_CONVERSATION, next: true, when: f => pastFirst(f) && f.talked,
    say: t => t("tree:guide.say.conversation", { clear: t("ui:coordinatorCard.clear") }) },
  { id: "another-repository", once: true, part: "project", side: "right", align: "start", next: true, when: pastFirst,
    say: t => t("tree:guide.say.anotherRepository", { create: t("chrome:projects.new") }) },
  { id: "phone", once: true, part: "settings", side: "bottom", align: "end", next: true,
    action: { label: t => t("tree:guide.openSteps"), run: () => openSettings("apps") },
    when: f => pastFirst(f) && f.apps && !f.narrow,
    say: t => t("tree:guide.say.phone", { settings: t("chrome:appBar.settings"), apps: t("panels:settings.tabs.apps") }) },
  // Then the rows being worked on; a Task left with no AI on it waits for the person, nothing there is the AI's yet.
  { id: "unassigned", part: "workingRow", side: "bottom", when: f => f.working > 0 && f.unowned === f.working,
    say: t => t("tree:guide.say.unassigned") },
  { id: "working", part: "workingRow", side: "bottom", when: f => f.working > 0,
    say: t => t("tree:guide.say.working", { section: turnSection(t) }) },
  // A message answered in the conversation itself, with no Task for it: that is where its reply is, once.
  { id: "direct", once: true, part: "conversation", ...AT_CONVERSATION, when: f => f.direct,
    say: t => t("tree:guide.say.direct") },
  // Before any turn, a request is to be written: over a list with nothing going on.
  { id: "send-again", part: "input", ...AT_INPUT, align: "end", when: f => f.stage.stage === "started",
    say: t => t("tree:guide.say.sendAgain") },
];

/**
 * The step shown: the first entry from the top whose facts hold, a step shown once (`once`) only while it is not done;
 * none when none does (the guide is over).
 */
export const guideEntry = (facts: GuideFacts): GuideEntry | null =>
  GUIDE.find(entry => !(entry.once && facts.seen.has(entry.id)) && entry.when(facts)) ?? null;

/**
 * A step shown once is done when the guide moves on from it to another: always, with no button of its own; with one,
 * only when its own facts no longer hold (it was not merely pushed aside by a step above it).
 */
export const doneOnLeaving = (left: GuideEntry | null, now: GuideEntry | null, facts: GuideFacts) =>
  !!left && left.id !== now?.id && !!left.once && (!left.next && !left.action || !left.when(facts));

/**
 * Whether the guide starts by itself: on a browser that has never had it, with the welcome on the screen and no Task in
 * the whole workspace (a new person's first look; not someone with work elsewhere opening an empty project).
 */
export const startsGuide = (stage: GuideStage | null, welcome: boolean, tasks: number) => stage === null && welcome && tasks === 0;

/**
 * The stage to store as a guide going on moves: the person's turn once a step of theirs (`turn`) holds; past its first
 * screen once another step than that screen's holds (something written or sent); over once no step holds. Undefined:
 * nothing to store.
 */
export function nextStage(stage: Exclude<GuideStage, { stage: "done" }>, entry: GuideEntry | null): GuideStage | undefined {
  if (!entry) return { stage: "done" };
  if (stage.stage !== "started") return undefined;
  if (entry.turn) return { stage: "turn", seen: stage.seen };
  return stage.intro && entry.id !== "send" ? { stage: "started", at: stage.at, seen: stage.seen } : undefined;
}
