import { useEffect, useMemo } from "react";
import { useEveryTaskIndex, useListPlace, usePeople, useWorkspaceInfo } from "@/data/queries";
import { beforeWork } from "@/domain/before-work";
import { crewOf } from "@/domain/people";
import { useAppHintOffered } from "@/features/coordinator/app-hint";
import { useDeviceValue } from "@/lib/device-storage";
import { useNarrow, useViewStore } from "@/state/view-store";
import { useConversation } from "@/features/coordinator/coordinator";
import { useInputDraft } from "@/features/coordinator/editor/draft";
import { answersIn, hasContent } from "@/features/coordinator/editor/document";
import { outgoing } from "@/features/coordinator/editor/outbox";
import { useDraftStore } from "@/features/forms/draft-store";
import { going, guideStage, moveGuide, type GoingStage } from "./guide-state";
import { guideEntry, nextStage, startsGuide, turnKind, type GuideEntry, type GuideFacts } from "./guide-definition";

const NO_TURNS: readonly CoordinatorTurn[] = [];
/** A message of the conversation not answered yet: waiting its turn, being handed over, or being worked on. */
const UNDER_WAY = new Set(["queued", "sending", "joined", "running"]);

type Answers = readonly { question: string }[] | undefined;
/** What the guide reads of one message of the conversation. */
export type CoordinatorTurn = { id: string; at: string; status: string; answers?: Answers };
/** What the guide reads of one message sent from this device and not in the conversation yet (its grace included). */
export type SendingMessage = { requestId: string; answers?: Answers };

/**
 * What the guide knows of the coordinator, from its conversation and what this device is still sending to it:
 * - `sent`: a message is in the conversation from after `since` (the guide's start), or is still being sent;
 * - `busy`: a message is still being sent, or one in the conversation is not answered yet;
 * - `answered`: among those, one carries an answer to a question still open (`questions`, by ID); another request
 *   being worked on is not an answer.
 */
export function coordinatorFacts({ since, turns, sending, questions }: {
  since: number | null; turns: readonly CoordinatorTurn[]; sending: readonly SendingMessage[]; questions: ReadonlySet<string>;
}): Pick<GuideFacts, "sent" | "busy" | "answered"> {
  const underWay = turns.filter(turn => UNDER_WAY.has(turn.status));
  const answers = (list: Answers) => !!list?.some(answer => questions.has(answer.question));
  return {
    sent: since !== null && (sending.length > 0 || turns.some(turn => Date.parse(turn.at) >= since)),
    busy: sending.length > 0 || underWay.length > 0,
    answered: sending.some(item => answers(item.answers)) || underWay.some(turn => answers(turn.answers)),
  };
}

/** This browser's guide while it goes on; null when it never started or is over (then nothing else is read for it). */
export const useGoingGuide = (): GoingStage | null => going(useDeviceValue(guideStage));

/**
 * Starts the guide on a new person's first look (startsGuide): read from the stored stage and the workspace's counts
 * alone, so a browser whose guide is over, or never starts, opens no draft and reads no conversation for it. Mounted
 * once, beside the balloon, so a stage is written by one owner only.
 */
export function useGuideStart() {
  const stage = useDeviceValue(guideStage);
  const welcome = useListPlace() === "welcome";
  const tasks = useWorkspaceInfo((info) => info.counts.tasks.root ?? 0);
  const starts = startsGuide(stage, welcome, tasks);
  useEffect(() => { if (starts) moveGuide(null, { stage: "started", at: Date.now(), seen: [] }); }, [starts]);
}

/**
 * The step of a guide going on (guide-definition.ts), from what the screen already holds: the Tasks in the workspace,
 * its rows awaiting the person (a question, or a report) and those still worked on (and whether an AI is on them), what the coordinator has from the
 * person (coordinatorFacts), what the input holds, and whether the Task open in the detail is the person's turn. Only
 * mounted while the guide goes on: it opens the input's draft.
 */
export function useGuide(stage: GoingStage): GuideEntry | null {
  const index = useEveryTaskIndex();
  const rows = useWorkspaceInfo((info) => info.home);
  const home = useWorkspaceInfo((info) => info.counts.home.root);
  const tasks = useWorkspaceInfo((info) => info.counts.tasks.root ?? 0);
  const welcome = useListPlace() === "welcome";
  const selected = useViewStore((state) => state.reader.open ? state.selected : null);
  // The rows awaiting the person, the questions they ask, and which of them is open in the detail: read from the list's
  // own rows, so the guide never says to open a row that is open already.
  let questions = 0, results = 0, unowned = 0, open: GuideFacts["open"] = null;
  const asked = new Set<string>();
  const people = usePeople();
  for (const row of rows) {
    const task = index.byId.get(row.taskId);
    // A row not started with no AI on it (as its History says it): the guide never calls it the AI's.
    if (row.section === "todo" && task && beforeWork(task, !!crewOf(task.id, people).responsible) === "unassigned") unowned++;
    if (row.section !== "review") continue;
    const kind = task ? turnKind(task) : "result";
    if (kind === "question") { questions++; if (task?.ball?.holder === "user" && task.ball.questionId) asked.add(task.ball.questionId); }
    else results++;
    if (row.taskId === selected) open = kind;
  }
  const working = (home?.doing ?? 0) + (home?.todo ?? 0) + (home?.awaited ?? 0);
  const opened = selected ? index.byId.get(selected) : undefined;
  // What the coordinator has from the person: sent from here and not in its conversation yet (its grace, "about to
  // send", included), and the conversation's own messages.
  const root = useConversation(state => state.root);
  const turns = useConversation(state => state.conversation?.turns) ?? NO_TURNS;
  const entries = useDraftStore(state => state.entries);
  const sending = useMemo(() => outgoing(entries, root)
    .filter(item => !item.taken && !item.cancelled && item.stage !== "refused" && !turns.some(turn => turn.id === item.requestId))
    .map(item => ({ requestId: item.requestId, answers: item.fixed.answers })), [entries, root, turns]);
  // What the input holds now: anything to send, and an answer to the Task open in the detail.
  const { doc } = useInputDraft();
  const drafting = hasContent(doc);
  const answerDrafted = !!opened && answersIn(doc, opened.id).length > 0;
  const narrow = useNarrow();
  const apps = useAppHintOffered();
  const seen = useMemo(() => new Set(stage.seen), [stage]);
  const coordinator = coordinatorFacts({ since: stage.stage === "started" ? stage.at : null, turns, sending, questions: asked });
  const facts: GuideFacts = { stage, tasks, questions, results, working, unowned, ...coordinator, welcome, drafting, answerDrafted, open, narrow, apps, seen };
  return guideEntry(facts);
}

/**
 * Stores the stage as a guide going on moves (nextStage), only over the stage it was decided on (moveGuide). Mounted
 * once, beside the balloon, so a stage is written by one owner only.
 */
export function useGuideStage(stage: GoingStage, entry: GuideEntry | null) {
  const next = nextStage(stage, entry);
  useEffect(() => { if (next) moveGuide(stage, next); }, [next?.stage]);
}
