import type { TFunction } from "i18next";
import { userTurn } from "@alpacawork/contract";
import type { Task } from "@/data/types";
import { exampleInDraft } from "@/features/coordinator/editor/draft";
import { openSettings } from "@/state/dialog-store";
import type { GuideStage } from "./guide-state";

/**
 * The getting-started guide, in one place: which parts of the screen it can point at, and its steps in order.
 *
 * How a step is chosen: the first entry of GUIDE, from the top, that is looked at and holds. The entries come in
 * phases, in this order:
 * - `first`: the first step (or it shown again), before anything is written or sent;
 * - `now`: what the person has just done: a message the coordinator is still on, words waiting to be sent, a message
 *   just answered in the conversation itself;
 * - `turn`: the person's turn: what is open in the detail (a question, a report, a Task being worked on), then the rows
 *   awaiting them;
 * - `close`: while the server says a Task they pressed Done on since the guide began is finished and no words wait to
 *   be sent (`closing`), what is left to know;
 * - `work`: other work going on in the list;
 * - `idle`: nothing going on.
 * Once `closing`, the `work` and `idle` phases are not looked at, so the guide is over when the close is read: then, and
 * only then, nothing holds while closing (nextStage). Otherwise, when nothing holds, nothing is shown and the guide waits.
 * Words
 * waiting to be sent sit between a question's answer and the label (`turn`) and the rest of `turn`; a message answered
 * in the conversation, after the rows awaiting the person.
 *
 * What a step says is said once; the guide itself goes on until it is over. A step explains its part the first time it
 * is the step (`say`). When what it holds under comes round again, it says only what is going on now and what to do
 * next (`again`), so the guide never stands showing nothing while there is something to do or to wait for; a step with
 * no `again` only explains, and is never the step again. Once `closing`, the first Task is finished: nothing is said
 * again, only what is left to explain, so the close is read whatever other work awaits the person, and the guide is
 * over with it.
 *
 * A step with no button is done as soon as its balloon has stood on the screen: it goes on standing, in the words it
 * was shown in, while it stays the step on this page (`standing`). One with a button is done when its button is
 * pressed, or when the guide moves on
 * from it after its balloon stood because its own facts no longer hold (doneOnLeaving); pushed aside while it still
 * holds, it comes back. A step that holds while its part is not on the screen shows nothing and the guide waits for
 * that part; one marked `passable` is passed over instead (`skipped`): the next step that holds is shown, and it comes
 * back when its part is seen again.
 *
 * To add a step, add one entry to GUIDE where it belongs in the order and its words to tree.json (every language):
 * - `id`: its name (also what "Got it" remembers);
 * - `phase`: where it belongs (above);
 * - `when`: the facts under which it holds;
 * - `part`, `side` and `align`: the part it points at (a name from PARTS), the side of that part its balloon stands on,
 *   and where along that side (middle unless said);
 * - `clear`: parts the balloon never stands over (what is read there stays read): the one holding the part pointed at,
 *   or those of its kind seen beside it; it stands by its part on the side where they let it nearest;
 * - `turn`: it is the person's turn (a question or a report awaits them); once one holds, the guide is past sending;
 * - `passable`: it is passed over while its part is not seen (above);
 * - `next`: it waits for "Got it": the way on from a step that only tells something. A step whose `action` is itself
 *   the way on (a request to try) has none, so nothing beside it reads as moving on without it;
 * - `action`: one thing the step offers to do from its balloon (its button's words and what it does); doing it puts
 *   the step away;
 * - `say`: its words, by its key, written out so the extractor reads it;
 * - `again`: its words when what it holds under comes round after it was said (above): what goes on and what is next.
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
  /** The words written in that box (the field itself, over the buttons at its foot). */
  words: ":is([data-coordinator-capsule], [data-composer-frame]) [role=textbox]",
  /** Its send button, while there is something to send. */
  send: "[data-ask-send]:not(:disabled)",
  /**
   * Where the coordinator is seen at work: "Open conversation" over that box, which says what it is doing (pressed, it
   * opens the conversation), or the open conversation's head.
   */
  coordinator: "[data-coordinator-pill][data-coordinator-expand], [data-coordinator-panel-head]",
  /** What stands in the row over that box: the conversation's button, and the buttons of the Task open in the detail. */
  overInput: "[data-coordinator-fold-row] > *",
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
  /** The open questions in the detail, in their box: each one's number, what it asks and its choices. */
  asked: "[data-waiting-report-actions]",
  /** The detail while it lies over the page (over the list, or taking the whole screen), not beside the list. */
  detailOver: 'aside[data-reader-mode]:not([data-reader-mode="docked"])',
  /** Done, which accepts a report, once it can be pressed. */
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
  /** The server says a Task the person pressed Done on since the guide began is finished (finishedHere). */
  doneHere: boolean;
  /** Done pressed here is on its way: sent, and the server does not say yet that the Task is finished (the screen itself says it was pressed). */
  settling: boolean;
  /** The conversation with the coordinator holds messages (it has not been cleared). */
  talked: boolean;
  /** The latest message to the coordinator was answered in the conversation itself, writing to no Task, unread. */
  direct: boolean;
  /** A request went to the coordinator after the guide started. */
  sent: boolean;
  /** The conversation with the coordinator is open over the foot. */
  conversationOpen: boolean;
  /** The coordinator is still on what the person sent (about to send, handing over, or working on it). */
  busy: boolean;
  /** What the person sent can still be taken back ("about to send"): the coordinator does not have it yet. */
  soon: boolean;
  /** The input holds something to send (written since the first step was shown again, while it is). */
  drafting: boolean;
  /** The Task seen in the detail: the person's turn on it (a question, or anything else), or being worked on. */
  open: "question" | "result" | "working" | null;
  /** Settings hold the guide to the installed app and the phone here (not on a touch screen). */
  apps: boolean;
  /** Steps said: put away by their button, shown (with no button), or left after their balloon stood on the screen. */
  seen: ReadonlySet<string>;
  /** The step whose balloon stands on this page now in its first words: said or not, it goes on in them while it holds. */
  standing: string | null;
  /** Steps passed over while what they point at is not seen (`passable`). */
  skipped: ReadonlySet<string>;
};

/** Where a step belongs in the order steps are chosen in (see the top). */
export type GuidePhase = "first" | "now" | "turn" | "close" | "work" | "idle";

export type GuideEntry = {
  id: string;
  phase: GuidePhase;
  when: (facts: GuideFacts) => boolean;
  part?: GuidePart;
  clear?: readonly GuidePart[];
  side?: GuideSide;
  align?: GuideAlign;
  turn?: boolean;
  passable?: boolean;
  next?: boolean;
  action?: { label: (t: TFunction) => string; run: (t: TFunction) => void };
  say: (t: TFunction) => string;
  again?: (t: TFunction) => string;
};

const turnSection = (t: TFunction) => t("tree:home.turn");
const finish = (t: TFunction) => t("ui:coordinatorCard.done");
/**
 * Every step at the input stands clear of the foot, what stands in the row over it, the conversation's panel while it is
 * open, and the detail: what is read and pressed there stays seen.
 */
const AT_INPUT = { clear: ["foot", "overInput", "panel", "detail"], side: "top" } as const;
/**
 * A step at the input while a report is open stands right over the input, from its start: its arrow lands on the input
 * (or the label in it) with nothing between, and Done at the end of the row over the input stays seen.
 */
const OVER_INPUT = { clear: ["foot", "detail"], side: "top", align: "start" } as const;
/** The step at the conversation itself stands right by its button, clear of the foot. */
const AT_CONVERSATION = { clear: ["foot"], side: "top", align: "start" } as const;
/**
 * The person has finished a Task here, as the server says, and no words wait in the input: the close is what is left.
 * While words wait, they come first (sent or taken away, the close goes on).
 */
export const closing = (f: Pick<GuideFacts, "doneHere" | "drafting">) => f.doneHere && !f.drafting;

export const GUIDE: readonly GuideEntry[] = [
  // The one input there is, and a request to try the whole flow with: the one way on from here.
  { id: "send", phase: "first", part: "input", ...AT_INPUT, align: "end",
    when: f => f.stage.stage === "started" && !f.drafting && !f.sent && (f.tasks === 0 || !!f.stage.intro),
    action: { label: t => t("tree:guide.tryExample"), run: t => exampleInDraft(t("tree:guide.example")) },
    say: t => t("tree:guide.say.send") },
  // Whatever was sent (a request, an answer, one more), while the coordinator is on it: not while it can still be
  // taken back, which the screen says itself.
  { id: "received", phase: "now", part: "coordinator", side: "top", when: f => f.busy && !f.soon,
    say: t => t("tree:guide.say.received"), again: t => t("tree:guide.again.received") },
  // A question open in the detail, until its answer is sent: right beside the questions' box, over the detail's margin;
  // where the detail lies over the page, clear of it (what is read over the questions stays read).
  { id: "answer", phase: "turn", turn: true, part: "asked", clear: ["detailOver", "foot", "overInput"], side: "left", align: "start", when: f => f.open === "question",
    say: t => t("tree:guide.say.answer"), again: t => t("tree:guide.again.answer") },
  // A report open with nothing written yet: it is there to look over, and more can be asked after it, with one more
  // to try (the one way on the step offers; Done stays there to press); then, with words written, the label that goes
  // with them, and that they are sent as they are (OVER_INPUT).
  { id: "more", phase: "turn", turn: true, passable: true, part: "input", ...OVER_INPUT,
    when: f => f.open === "result" && !f.drafting,
    action: { label: t => t("tree:guide.tryExample"), run: t => exampleInDraft(t("tree:guide.moreExample")) },
    say: t => t("tree:guide.say.more") },
  { id: "label", phase: "turn", turn: true, passable: true, part: "label", ...OVER_INPUT,
    when: f => f.open === "result" && f.drafting && f.labelled && f.seen.has("more"),
    say: t => t("tree:guide.say.label") },
  // Words in the input: they wait to be sent. Right by the send button: beside the input where there is room, else
  // over the buttons at its foot (never over the words written).
  { id: "send-ready", phase: "now", part: "send", clear: ["words", "overInput", "panel"], side: "right", when: f => f.drafting,
    say: t => t("tree:guide.say.sendReady"), again: t => t("tree:guide.say.sendReady") },
  // Done on an open report.
  { id: "accept", phase: "turn", turn: true, part: "finish", side: "top", align: "end", when: f => f.open === "result",
    say: t => t("tree:guide.say.accept", { finish: finish(t) }), again: t => t("tree:guide.again.accept", { finish: finish(t) }) },
  // A Task being worked on, opened before anything has come back from it (the person looking round during their
  // first wait): where the AI on it is stopped. Once they have had a turn, the detail stays open on the Task they
  // answered, and what is said there is that its work goes on (`working`), not this.
  { id: "stop", phase: "turn", passable: true, part: "taskState", side: "top", align: "end", next: true,
    when: f => f.open === "working" && f.stage.stage === "started",
    say: t => t("tree:guide.say.stop", { stop: t("forms:reportForm.stopTitle") }) },
  // The rows awaiting the person, the question first: said while none of their kind is open in the detail already.
  { id: "question", phase: "turn", turn: true, part: "questionRow", side: "bottom", when: f => f.questions > 0 && f.open !== "question",
    say: t => t("tree:guide.say.question"), again: t => t("tree:guide.again.question") },
  { id: "result", phase: "turn", turn: true, part: "resultRow", side: "bottom", when: f => f.results > 0 && f.open !== "result",
    say: t => t("tree:guide.say.result"), again: t => t("tree:guide.again.result") },
  // A message just answered in the conversation itself, with no Task for it: where its reply is, while the
  // conversation is folded (opened, the reply is there to read, and the step is done). Said once: after it, the
  // input is where the guide goes on.
  { id: "direct", phase: "now", passable: true, part: "coordinator", side: "top", align: "start", when: f => f.direct && !f.conversationOpen,
    say: t => t("tree:guide.say.direct") },
  // The close: the conversation with the coordinator is for throwing away (what is to be kept goes into a Task;
  // pointed at by its button folded, by Clear conversation open, and done once cleared); where another repository is
  // taken on; and where settings hold the steps to answering from a phone (installing the app is asked as setup ends).
  { id: "conversation", phase: "close", passable: true, part: "conversation", ...AT_CONVERSATION, next: true, when: f => f.talked,
    say: t => t("tree:guide.say.conversation", { clear: t("ui:coordinatorCard.clear") }) },
  { id: "another-repository", phase: "close", passable: true, part: "project", side: "right", align: "start", next: true, when: () => true,
    say: t => t("tree:guide.say.anotherRepository", { create: t("chrome:projects.new") }) },
  { id: "phone", phase: "close", passable: true, part: "settings", side: "bottom", align: "end", next: true,
    action: { label: t => t("tree:guide.openSteps"), run: () => openSettings("apps") },
    when: f => f.apps,
    say: t => t("tree:guide.say.phone", { settings: t("chrome:appBar.settings"), apps: t("panels:settings.tabs.apps") }) },
  // Other work: a Task left with no AI on it waits for the person, nothing there is the AI's yet.
  { id: "unassigned", phase: "work", part: "workingRow", side: "bottom", when: f => f.working > 0 && f.unowned === f.working,
    say: t => t("tree:guide.say.unassigned"), again: t => t("tree:guide.say.unassigned") },
  { id: "working", phase: "work", part: "workingRow", side: "bottom", when: f => f.working > 0,
    say: t => t("tree:guide.say.working", { section: turnSection(t) }), again: t => t("tree:guide.again.working", { section: turnSection(t) }) },
  // Nothing going on and nothing written: a request is to be written, with the request to try the whole flow with (as
  // on the first step). Not while what the person just sent or finished is on its way: the screen says so itself, and
  // what follows it is said next.
  { id: "send-again", phase: "idle", part: "input", ...AT_INPUT, align: "end", when: f => !f.drafting && !f.busy && !f.settling,
    action: { label: t => t("tree:guide.tryExample"), run: t => exampleInDraft(t("tree:guide.example")) },
    say: t => t("tree:guide.say.sendAgain"), again: t => t("tree:guide.say.sendAgain") },
];

/** Whether a phase is looked at: once `closing`, the close takes the place of other work and of nothing going on. */
const looked = (phase: GuidePhase, f: GuideFacts) => phase === "close" ? closing(f) : phase === "work" || phase === "idle" ? !closing(f) : true;

/** A step with no button, done by being shown, stays the step in its first words while its balloon stands on this page; one put away by its button does not. */
const stays = (entry: GuideEntry, facts: Pick<GuideFacts, "standing">) => entry.id === facts.standing && !hasButton(entry);

/** Whether a step is shown in its words for coming round again (`again`): it was said, and is not still standing as it was first said. */
export const saidBefore = (entry: GuideEntry, facts: Pick<GuideFacts, "seen" | "standing">) => facts.seen.has(entry.id) && !stays(entry, facts);

/**
 * The step shown (see the top): the first entry looked at that holds and is not said, is still standing as first said,
 * or, before `closing`, has words for coming round again (saidBefore says which words it is shown in); past those passed over while
 * their part is not seen; with only those holding, the first of them (nothing is shown, and the guide waits for it);
 * none when none holds (the guide waits, or is over while closing: nextStage).
 */
export function guideEntry(facts: GuideFacts): GuideEntry | null {
  const again = !closing(facts);
  const holding = GUIDE.filter(entry => looked(entry.phase, facts) && (!saidBefore(entry, facts) || again && !!entry.again) && entry.when(facts));
  return holding.find(entry => !facts.skipped.has(entry.id)) ?? holding[0] ?? null;
}

/** Whether a step waits for a press of its own: "Got it", or what it offers to do. */
export const hasButton = (entry: GuideEntry) => !!entry.next || !!entry.action;
/** A step with no button is done as soon as its balloon has stood on the screen (`stood`). */
export const doneOnShowing = (entry: GuideEntry, stood: boolean) => stood && !hasButton(entry);
/**
 * A step with a button is done when the guide moves on from it to another after its balloon stood on the screen
 * (`stood`) because its own facts no longer hold (it was not merely pushed aside by a step above it). One never shown,
 * or passed over while its part is not seen, is not done.
 */
export const doneOnLeaving = (left: GuideEntry | null, now: GuideEntry | null, facts: GuideFacts, stood: boolean) =>
  !!left && left.id !== now?.id && stood && hasButton(left) && !facts.skipped.has(left.id) && !left.when(facts);

/**
 * Whether the guide starts by itself: on a browser that has never had it, with the welcome on the screen and no Task in
 * the whole workspace (a new person's first look; not someone with work elsewhere opening an empty project).
 */
export const startsGuide = (stage: GuideStage | null, welcome: boolean, tasks: number) => stage === null && welcome && tasks === 0;

/**
 * The stage to store as a guide going on moves: the person's turn once a step of theirs (`turn`) holds; past its first
 * step once another step than that one holds (something written or sent); over, as read to its end, once no step
 * holds while `closing` (the close is read). What else it keeps (`seen`, `finished`) goes along. Undefined: nothing to store.
 */
export function nextStage(stage: Exclude<GuideStage, { stage: "done" }>, entry: GuideEntry | null, closing: boolean): GuideStage | undefined {
  if (!entry) return closing ? { stage: "done", read: true } : undefined;
  if (stage.stage !== "started") return undefined;
  const { at: _at, intro: _intro, ...kept } = stage;
  if (entry.turn) return { ...kept, stage: "turn" };
  return stage.intro && entry.id !== "send" ? { ...kept, at: stage.at } : undefined;
}

/**
 * The Tasks pressed Done on since the guide began that the server says are finished: `state` is a Task's state as the
 * server says it now (the list's row, or the Task read again once the list lets it go), undefined while not known.
 * Nothing else counts: Done still on its way, taken back, a Task put on hold or let go by the list for another reason.
 */
export const finishedHere = (ids: readonly string[], state: (id: string) => string | undefined) =>
  ids.filter(id => state(id) === "done");
