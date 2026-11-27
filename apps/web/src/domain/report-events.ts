import { inGallery, reportEmbed, reportMark, reportMediaReferences, type HistoryEventKind } from "@alpacawork/contract";
import { turnRecord } from "@alpacawork/contract/control";
import type { TaskState } from "@/data/types";
import { eventKey, type HistoryEvent } from "./history";
import type { MarkKind, MarkTone } from "@/components/ui/timeline-mark";

/** One History event as the report column draws it. The server chose it and its kind; this only says how it looks. */
export type ReportEvent = {
  key: string; at: string;
  /** What the record is, as the server says (contract history-events). */
  kind: HistoryEventKind;
  text: string; description: string | null;
  note?: HistoryEvent["note"];
  /** A member Request's result: the reply of the Run that took it in, read whole when it opens. */
  result?: HistoryEvent["result"];
  /** Record links projected by the backend, never guessed from wording or nearby times. */
  id: string; taskId: string; author?: HistoryEvent["author"]; recipient?: HistoryEvent["recipient"]; coordinator?: HistoryEvent["coordinator"];
  answers?: string; message?: string; wordsKey?: string; askedTo?: HistoryEvent["askedTo"];
  answerText?: string; answerFiles?: HistoryEvent["answerFiles"]; quote?: string; wroteIn?: string; consumedBy?: string[]; causes?: HistoryEvent["causes"];
  /** Membership in the server's userQuestions projection, including held questions. */
  userQuestion?: boolean;
  /** A card's mark: what a placement reported, asked or commented (reportMark). Null on a quiet row. */
  mark: { kind: MarkKind; tone: MarkTone } | null;
  /** The record that finished the task while it is still done (finishedBy): a quiet row with FINISH_MARK on the rail. */
  finish?: boolean;
  /** On a failed Run's row, the cause the backend read in its error words. */
  cause?: HistoryEvent["cause"];
  carriedOn?: true;
  /** On a conversation row, what happened to the agent's conversation: started anew, or compacted with its fill. */
  conversation?: HistoryEvent["conversation"];
  /** A failed Run the column offers to close. */
  runId?: string;
  /** The child whose record it is, in its parent's column: what it reported, asked its ancestors or set, never a wait on you. */
  sourceTaskId?: string;
  /**
   * It stands pinned, never folded: a question still open (the History's `open`), or the review the user's turn waits
   * on (turnRecord). Whose turn it is colours its mark, not whether it is pinned.
   */
  pinned?: boolean;
  /** This Task's current question/review, as its own ball says. */
  currentWait?: boolean;
  /** An open question's record ID, which its choices answer. */
  question?: string;
  /** A wait (question or review) closed by something other than its answer or confirmation (released): drawn quiet, saying why. */
  released?: Released;
  /** A dialogue's reply as a row of its own: the dialogue's key, which its gallery and its address stay on. */
  replyTo?: string;
  /** Authorship of a record written by a person, the coordinator or an automation. */
  by?: NonNullable<HistoryEvent["by"]>;
  /** The state a person's or the Coordinator's act alone set (a hold, its return, a confirmation, a stop). */
  changed?: TaskState;
  /** The state the record set, as the server says (the History's `state`); absent when it kept the state. */
  set?: TaskState;
};

export { reportDisplay, reportChildren, reportContains, displayKind } from '@alpacawork/contract';
export type { ReportTier } from '@alpacawork/contract';
export type ReportNode = import('@alpacawork/contract').DisplayNode<ReportEvent>;
export type ReportRow = import('@alpacawork/contract').DisplayRow<ReportEvent>;

export function firstReportMedia(text: string): string | null {
  for (const reference of reportMediaReferences(text)) {
    const embed = reportEmbed(reference.path);
    if (embed && inGallery(embed.kind)) return embed.path;
  }
  return null;
}

/** The done check where a task finished (finishedBy), as the list's done state icon draws it. */
export const FINISH_MARK = { kind: "approve", tone: "done" } as const satisfies NonNullable<ReportEvent["mark"]>;
/** Where a task stopped, while it is still stopped, on the list's line. */
export const STOP_MARK = { kind: "error", tone: "error" } as const satisfies NonNullable<ReportEvent["mark"]>;

/**
 * A record's one colour in the column, said by what it did to the work and never by which way it went: its rail
 * mark and the line drawn beside it when it is pointed at or jumped to agree. In the state colours (tone.ts):
 * stopped by a failure (error), finished (done), waiting on you (turn, only while your turn waits on it; once
 * answered it is quiet), or set to work: an instruction or an answer, which wake the one they go to, or a record that
 * put the Task back to work (working). What happened to an agent's conversation has a colour of its own
 * (conversation). A record that changed nothing else, or whose effect the server does not say, stays quiet: no colour
 * is guessed.
 */
export function reportTone(report: Pick<ReportEvent, "kind" | "mark" | "finish" | "set" | "carriedOn">): MarkTone {
  if (report.kind === "error") return report.carriedOn ? "quiet" : "error";
  if (report.kind === "conversation") return "conversation";
  if (report.finish || report.set === "done") return "done";
  if (report.mark?.tone === "turn") return "turn";
  return report.kind === "request" || report.kind === "answer" || report.set === "doing" ? "working" : "quiet";
}

export { reportMark } from "@alpacawork/contract";

export { turnRecord };

/** Why a wait closed when no answer or confirmation closed it: the History's closure of a question or a review. */
export type Released = Exclude<NonNullable<HistoryEvent["closure"]>, "answered" | "confirmed">;

/**
 * The one rule for a closed wait. A question or review closed by its answer or confirmation keeps its look; one
 * closed for any other reason (withdrawn, expired, its review invalidated or stopped) is released.
 */
export function released(event: Pick<HistoryEvent, "closure">): Released | undefined {
  return event.closure === undefined || event.closure === "answered" || event.closure === "confirmed" ? undefined : event.closure;
}

/** Every instruction, including a review's send-back, is its Request's row. */
export const isInstruction = (report: Pick<ReportEvent, "kind">) => report.kind === "request";

/**
 * One History event as the column draws it: what a placement reported, asked or commented as a card, a state a person
 * or the Coordinator alone set as who set which state, and anything else as a quiet row of its own words. `turn` is
 * the record a Task's user turn waits on (turnRecord): it alone takes the turn's colour.
 */
export function reportEvent(event: HistoryEvent, turn: (taskId: string) => string | null): ReportEvent {
  const yours = (event.kind === "question" || event.kind === "review") && turn(event.taskId) === event.id;
  const open = event.kind === "question" && event.open === true;
  const pinned = open || event.kind === "review" && yours;
  const mark = event.by ? null : reportMark(event);
  const closed = released(event);
  return { key: eventKey(event), at: event.at, kind: event.kind, text: event.title.trim(), description: (event.kind === "answer" ? event.answerText ?? event.summary : event.summary) || null,
    id: event.id, taskId: event.taskId, author: event.author, recipient: event.recipient, coordinator: event.coordinator,
    answers: event.answers, message: event.message, wordsKey: event.wordsKey, askedTo: event.askedTo, userQuestion: event.userQuestion,
    answerText: event.answerText, quote: event.quote, wroteIn: event.runId, consumedBy: event.consumedBy, causes: event.causes,
    ...(event.note ? { note: event.note } : {}),
    ...(event.answerFiles ? { answerFiles: event.answerFiles } : {}),
    ...(event.cause ? { cause: event.cause } : {}),
    ...(event.carriedOn ? { carriedOn: true } : {}),
    ...(event.conversation ? { conversation: event.conversation } : {}),
    ...(event.result ? { result: event.result } : {}),
    mark: mark && (yours || closed) ? { ...mark, tone: yours ? "turn" : "quiet" } : mark,
    ...(event.fromChild ? { sourceTaskId: event.taskId } : {}),
    ...(pinned ? { pinned } : {}),
    ...(open ? { question: event.id } : {}),
    ...(closed ? { released: closed } : {}),
    ...(event.by ? { by: event.by } : {}),
    ...(event.state ? { set: event.state } : {}),
    ...(event.by && event.state ? { changed: event.state } : {}) };
}
