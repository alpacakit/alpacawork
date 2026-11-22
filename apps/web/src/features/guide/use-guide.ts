import { useEffect, useMemo, useRef } from "react";
import { useEveryTaskIndex, useListPlace, usePeople, useWorkspaceInfo } from "@/data/queries";
import { beforeWork } from "@/domain/before-work";
import { crewOf } from "@/domain/people";
import { useAppGuideHere } from "@/features/coordinator/app-hint";
import { useDeviceValue } from "@/lib/device-storage";
import { useNarrow, useViewStore } from "@/state/view-store";
import { useConversation } from "@/features/coordinator/coordinator";
import { useInputDraft } from "@/features/coordinator/editor/draft";
import { hasContent, inlines } from "@/features/coordinator/editor/document";
import { outgoing } from "@/features/coordinator/editor/outbox";
import { useDraftStore } from "@/features/forms/draft-store";
import { replaceStep } from "@/lib/history";
import { useSitting } from "@/features/reader/next-question";
import { going, guideStage, moveGuide, putAway, restartGuide, type GoingStage } from "./guide-state";
import { doneOnLeaving, guideEntry, nextStage, startsGuide, turnKind, type GuideEntry, type GuideFacts } from "./guide-definition";

const NO_TURNS: readonly CoordinatorTurn[] = [];
/** A message of the conversation not answered yet: waiting its turn, being handed over, or being worked on. */
const UNDER_WAY = new Set(["queued", "sending", "joined", "running"]);

/** What the guide reads of one message of the conversation. */
export type CoordinatorTurn = { id: string; at: string; status: string };

/**
 * What the guide knows of the coordinator, from its conversation and what this device is still sending to it (by
 * request ID, its grace included):
 * - `sent`: a message is in the conversation from after `since` (the guide's start), or is still being sent;
 * - `busy`: a message is still being sent, or one in the conversation is not answered yet (a request, an answer, or
 *   one more alike).
 */
export function coordinatorFacts({ since, turns, sending }: {
  since: number | null; turns: readonly CoordinatorTurn[]; sending: readonly string[];
}): Pick<GuideFacts, "sent" | "busy"> {
  return {
    sent: since !== null && (sending.length > 0 || turns.some(turn => Date.parse(turn.at) >= since)),
    busy: sending.length > 0 || turns.some(turn => UNDER_WAY.has(turn.status)),
  };
}

/** What the input held when the first screen was shown again (at `at`), and whether it still holds just that. */
type FoundDraft = { at: number; written: string; same: boolean } | null;
/**
 * While the first screen is shown again, what the input already held then is not the person writing: only a change to
 * it is, so that screen stays until they write, send or close it. `written` is the input as it is now.
 */
export function foundDraft(stage: GoingStage, written: string, before: FoundDraft): FoundDraft {
  if (stage.stage !== "started" || !stage.intro) return null;
  const kept = before?.at === stage.at ? before.written : written;
  return { at: stage.at, written: kept, same: kept === written };
}

/** This browser's guide while it goes on; null when it never started or is over (then nothing else is read for it). */
export const useGoingGuide = (): GoingStage | null => going(useDeviceValue(guideStage));

/**
 * Opened with `?guide=restart`, the guide starts over as settings' "Show again" does (for trying it again without
 * clearing the browser's data); the address then drops it, so a reload does not start it over again.
 */
export function useGuideRestartFromUrl() {
  useEffect(() => {
    const url = new URL(location.href);
    if (url.searchParams.get("guide") !== "restart") return;
    url.searchParams.delete("guide");
    replaceStep(history.state, url);
    restartGuide();
  }, []);
}

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
 * its rows awaiting the person (a question, or a report) and those still worked on (and whether an AI is on them), what
 * the coordinator has from the person (coordinatorFacts), what the input holds, and whether the Task open in the detail
 * is the person's turn or being worked on. Only
 * mounted while the guide goes on: it opens the input's draft.
 */
export function useGuide(stage: GoingStage): GuideEntry | null {
  const index = useEveryTaskIndex();
  const rows = useWorkspaceInfo((info) => info.home);
  const home = useWorkspaceInfo((info) => info.counts.home.root);
  const tasks = useWorkspaceInfo((info) => info.counts.tasks.root ?? 0);
  // The Task seen in the detail: open there, and not under the card that says every turn is answered.
  const shown = useViewStore((state) => state.reader.open ? state.selected : null);
  const answeredAll = useSitting(state => state.emptied?.taskId ?? null);
  const selected = shown === answeredAll ? null : shown;
  // The rows awaiting the person, and which of them is seen in the detail: read from the list's own rows, so the guide
  // never says to open a row that is open already.
  let questions = 0, results = 0, unowned = 0, open: GuideFacts["open"] = null;
  const people = usePeople();
  for (const row of rows) {
    const task = index.byId.get(row.taskId);
    // A row not started with no AI on it (as its History says it): the guide never calls it the AI's.
    if (row.section === "todo" && task && beforeWork(task, !!crewOf(task.id, people).responsible) === "unassigned") unowned++;
    if (row.section !== "review") continue;
    const kind = task ? turnKind(task) : "result";
    if (kind === "question") questions++; else results++;
    if (row.taskId === selected) open = kind;
  }
  const working = (home?.doing ?? 0) + (home?.todo ?? 0) + (home?.awaited ?? 0);
  const opened = selected ? index.byId.get(selected) : undefined;
  // Seen in the detail and not the person's turn: being worked on, where the AI on it can be stopped.
  if (!open && opened?.state === "doing") open = "working";
  // What the coordinator has from the person: sent from here and not in its conversation yet (its grace, "about to
  // send", included), and the conversation's own messages.
  const root = useConversation(state => state.root);
  const turns = useConversation(state => state.conversation?.turns) ?? NO_TURNS;
  const entries = useDraftStore(state => state.entries);
  const sending = useMemo(() => outgoing(entries, root)
    .filter(item => !item.taken && !item.cancelled && item.stage !== "refused" && !turns.some(turn => turn.id === item.requestId))
    .map(item => item.requestId), [entries, root, turns]);
  // What the input holds now: anything to send (foundDraft), and a label.
  const { doc } = useInputDraft();
  const found = useRef<FoundDraft>(null);
  found.current = foundDraft(stage, JSON.stringify(doc), found.current);
  const drafting = hasContent(doc) && !found.current?.same;
  const labelled = inlines(doc).some(node => node.type === "taskLabel");
  const narrow = useNarrow();
  // Not app-hint's "done": that is set by the first message sent, which everyone at the guide's last step has sent.
  const apps = useAppGuideHere();
  const seen = useMemo(() => new Set(stage.seen), [stage]);
  const coordinator = coordinatorFacts({ since: stage.stage === "started" ? stage.at : null, turns, sending });
  const facts: GuideFacts = { stage, tasks, questions, results, working, unowned, ...coordinator, labelled, drafting, open, narrow, apps, seen };
  return guideEntry(facts);
}

/**
 * Stores the stage as a guide going on moves (nextStage), only over the stage it was decided on (moveGuide), and puts
 * away a step shown once with no button as the guide moves on from it (doneOnLeaving). Mounted once, beside the
 * balloon, so a stage is written by one owner only.
 */
export function useGuideStage(stage: GoingStage, entry: GuideEntry | null) {
  const next = nextStage(stage, entry);
  const key = next && JSON.stringify(next);
  useEffect(() => { if (next) moveGuide(stage, next); }, [key]);
  const held = useRef<GuideEntry | null>(null);
  useEffect(() => {
    if (doneOnLeaving(held.current, entry)) putAway(held.current!.id);
    held.current = entry;
  }, [entry?.id]);
}
