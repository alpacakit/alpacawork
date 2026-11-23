import { useEffect, useMemo, useRef } from "react";
import { useQueries } from "@tanstack/react-query";
import { z } from "zod";
import { useShallow } from "zustand/react/shallow";
import { useEveryTaskIndex, useListPlace, usePeople, useWorkspaceInfo } from "@/data/queries";
import { ApiError } from "@/data/client";
import { api } from "@/data/resources";
import { beforeWork } from "@/domain/before-work";
import { crewOf } from "@/domain/people";
import { useCoarsePointer } from "@/lib/input-capabilities";
import { useDeviceValue } from "@/lib/device-storage";
import { useNarrow, useViewStore } from "@/state/view-store";
import { useConversation } from "@/features/coordinator/coordinator";
import { useInputDraft } from "@/features/coordinator/editor/draft";
import { hasContent, inlines } from "@/features/coordinator/editor/document";
import { outgoing } from "@/features/coordinator/editor/outbox";
import { useDraftStore } from "@/features/forms/draft-store";
import { useSitting } from "@/features/reader/next-question";
import { readerOutcome } from "@/features/reader/submission";
import { useSubmittedTurns } from "@/features/reader/submitted-turns";
import type { Task } from "@/data/types";
import { going, guideStage, moveGuide, putAway, type GoingStage } from "./guide-state";
import { closing, doneOnLeaving, finishedHere, guideEntry, nextStage, startsGuide, turnKind, type GuideEntry, type GuideFacts } from "./guide-definition";

const NO_TURNS: readonly CoordinatorTurn[] = [];
/** A message of the conversation not answered yet: waiting its turn, being handed over, or being worked on. */
const UNDER_WAY = new Set(["queued", "sending", "joined", "running"]);

/** What the guide reads of one message of the conversation: what its answer wrote on Tasks once it ended, and whether its answer has been read. */
export type CoordinatorTurn = { id: string; at: string; status: string; result?: { writes: readonly unknown[] } | null; seen?: boolean };

/**
 * What the guide knows of the coordinator, from its conversation and what this device is still sending to it (by
 * request ID, its grace included):
 * - `sent`: a message is in the conversation from after `since` (the guide's start), or is still being sent;
 * - `busy`: a message is still being sent, or one in the conversation is not answered yet (a request, an answer, or
 *   one more alike);
 * - `talked`: the conversation holds messages;
 * - `direct`: nothing is under way and the latest message was answered there, its answer writing to no Task and not
 *   read yet (read with the conversation open, there is nothing to point at).
 */
export function coordinatorFacts({ since, turns, sending }: {
  since: number | null; turns: readonly CoordinatorTurn[]; sending: readonly string[];
}): Pick<GuideFacts, "sent" | "busy" | "talked" | "direct"> {
  const busy = sending.length > 0 || turns.some(turn => UNDER_WAY.has(turn.status));
  const latest = turns.at(-1);
  return {
    sent: since !== null && (sending.length > 0 || turns.some(turn => Date.parse(turn.at) >= since)),
    busy, talked: turns.length > 0,
    direct: !busy && latest?.status === "succeeded" && !!latest.result && latest.result.writes.length === 0 && !latest.seen,
  };
}

/** What the input held when the first step was shown again (at `at`), and whether it still holds just that. */
type FoundDraft = { at: number; written: string; same: boolean } | null;
/**
 * While the first step is shown again, what the input already held then is not the person writing: only a change to
 * it is, so that step stays until they write, send or close it. `written` is the input as it is now.
 */
export function foundDraft(stage: GoingStage, written: string, before: FoundDraft): FoundDraft {
  if (stage.stage !== "started" || !stage.intro) return null;
  const kept = before?.at === stage.at ? before.written : written;
  return { at: stage.at, written: kept, same: kept === written };
}

/**
 * The rows awaiting the person, as the list's own rows have them (so the guide never says to open a row that is open
 * already), and which of them is `selected` in the detail. A row whose turn the person has already answered from here
 * (an answer sent, Done pressed: `submitted`, as the reader's own next-question deck counts them) is not theirs any
 * more, while it still stands in the list for the moment it can be taken back.
 */
export function awaiting(rows: readonly { taskId: string; section: string }[], byId: ReadonlyMap<string, Task>, submitted: (task: Task) => boolean,
  selected: string | null): Pick<GuideFacts, "questions" | "results" | "open"> {
  let questions = 0, results = 0, open: GuideFacts["open"] = null;
  for (const row of rows) {
    if (row.section !== "review") continue;
    const task = byId.get(row.taskId);
    if (task && submitted(task)) continue;
    const kind = task ? turnKind(task) : "result";
    if (kind === "question") questions++; else results++;
    if (row.taskId === selected) open = kind;
  }
  return { questions, results, open };
}

/** One press of Done the reader holds: which press it was (its send), and the Task it was pressed on. */
export type DonePress = { press: string; task: string };
/** The presses of Done held when this guide began (at `at`), and the Tasks Done was pressed on since (`fresh`). */
type DoneBefore = { at: number | null; presses: readonly string[]; fresh: readonly string[] } | null;
/**
 * Done pressed since the guide began: the reader keeps what was pressed for as long as the page is open, so a press it
 * already held when the guide started (again) is not this guide's; a new press on the same Task is. `done` is the
 * presses it holds now.
 */
export function doneSince(stage: GoingStage, done: readonly DonePress[], before: DoneBefore): NonNullable<DoneBefore> {
  const at = stage.stage === "started" ? stage.at : before?.at ?? null;
  const presses = before && before.at === at ? before.presses : stage.stage === "started" ? done.map(each => each.press) : before?.presses ?? [];
  return { at, presses, fresh: done.filter(each => !presses.includes(each.press)).map(each => each.task) };
}

const stateRead = z.object({ task: z.object({ state: z.string() }) });
/**
 * Each of `ids`' state as the server says it now: the list's row while it holds one; once the list lets it go (finished,
 * stopped, or anything else), the Task read again from the server, each time it is let go and on each load. Undefined
 * while that read is under way (tried again until it is read, unless the Task is gone): not known.
 */
export function useServerState(ids: readonly string[], byId: ReadonlyMap<string, Task>): (id: string) => string | undefined {
  const root = useWorkspaceInfo((info) => info.root);
  const reads = useQueries({ queries: ids.map(id => ({
    queryKey: ["guide-task-state", root, id] as const,
    queryFn: ({ signal }: { signal: AbortSignal }) => api.request(`task/view?task=${encodeURIComponent(id)}`, stateRead, signal).then(read => read.task.state),
    enabled: !byId.has(id), staleTime: 0, retry: (_: number, error: Error) => !(error instanceof ApiError && error.code === "not_found"), refetchOnWindowFocus: false, refetchOnReconnect: false,
  })) });
  return id => {
    const listed = byId.get(id);
    if (listed) return listed.state;
    const read = reads[ids.indexOf(id)];
    return read && !read.isFetching ? read.data : undefined;
  };
}

/**
 * Whether the guide is shown on this screen: on a computer's, never at a phone's width (useNarrow, the app's one rule
 * for a phone's layout). On a phone it keeps its stage as it is, so it goes on once the screen is opened on a computer;
 * the welcome says so (Welcome).
 */
export const useGuideShown = () => !useNarrow();

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
 * its rows awaiting the person (a question, or a report) and those still worked on (and whether an AI is on them), what
 * the coordinator has from the person (coordinatorFacts), what the input holds, and whether the Task open in the detail
 * is the person's turn or being worked on. Only
 * mounted while the guide goes on: it opens the input's draft.
 */
export function useGuide(stage: GoingStage, skipped: ReadonlySet<string>): { entry: GuideEntry | null; facts: GuideFacts; fresh: readonly string[]; ready: boolean } {
  const index = useEveryTaskIndex();
  const rows = useWorkspaceInfo((info) => info.home);
  const home = useWorkspaceInfo((info) => info.counts.home.root);
  const tasks = useWorkspaceInfo((info) => info.counts.tasks.root ?? 0);
  // Done pressed on a Task here, as the reader keeps it (its next-question deck), since this guide began (doneSince),
  // with those the stage keeps; counted while the server says the Task is finished (finishedHere).
  // Each press by its send (or, with none, the turn it was pressed on), so pressing again on the same Task is new.
  const doneKeys = useSitting(useShallow(state => Object.entries(state.departures)
    .filter(([, each]) => each.answer === "done" && readerOutcome(each.status()) === "kept")
    .map(([task, each]) => JSON.stringify([each.id ?? `turn:${each.turn}`, task]))));
  const doneBefore = useRef<DoneBefore>(null);
  doneBefore.current = doneSince(stage, doneKeys.map(key => { const [press, task] = JSON.parse(key) as [string, string]; return { press, task }; }), doneBefore.current);
  const fresh = doneBefore.current.fresh;
  // The Task seen in the detail: open there, and not under the card that says every turn is answered.
  const shown = useViewStore((state) => state.reader.open ? state.selected : null);
  const answeredAll = useSitting(state => state.emptied?.taskId ?? null);
  const selected = shown === answeredAll ? null : shown;
  // The rows awaiting the person, and which of them is seen in the detail (awaiting).
  const { submitted } = useSubmittedTurns();
  const awaited = awaiting(rows, index.byId, submitted, selected);
  const { questions, results } = awaited;
  let { open } = awaited;
  let unowned = 0;
  const people = usePeople();
  for (const row of rows) {
    const task = index.byId.get(row.taskId);
    // A row not started with no AI on it (as its History says it): the guide never calls it the AI's.
    if (row.section === "todo" && task && beforeWork(task, !!crewOf(task.id, people).responsible) === "unassigned") unowned++;
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
  // Settings hold the app and phone steps wherever the pointer is not a touch (SettingsDialog).
  const apps = !useCoarsePointer();
  const seen = useMemo(() => new Set(stage.seen), [stage]);
  const coordinator = coordinatorFacts({ since: stage.stage === "started" ? stage.at : null, turns, sending });
  const conversationOpen = useConversation(state => state.expanded);
  const pressed = [...new Set([...stage.finished ?? [], ...fresh])];
  const doneHere = finishedHere(pressed, useServerState(pressed, index.byId)).length > 0;
  // The step standing on this page as it was last chosen: it stays the step while it holds, done or not.
  const standing = useRef<string | null>(null);
  const facts: GuideFacts = { stage, tasks, doneHere, questions, results, working, unowned, ...coordinator, conversationOpen, labelled, drafting, open,
    apps, seen, skipped, standing: standing.current };
  // Until the conversation is read, what the coordinator has and what the input holds are not known: no step is chosen.
  const ready = useConversation(state => state.conversation !== null);
  const entry = ready ? guideEntry(facts) : null;
  if (ready) standing.current = entry?.id ?? null;
  return { entry, facts, fresh, ready };
}

/**
 * Stores the stage as a guide going on moves (nextStage), only over the stage it was decided on (moveGuide): the Tasks
 * Done was pressed on since it began (`fresh`, kept as `finished` whatever step shows), and puts away a step with a
 * button as the guide moves on from it (doneOnLeaving; `stood`: its balloon has stood on this page). Nothing is stored
 * while the guide is not `ready`. Mounted once, beside the balloon, so a stage is written by one owner only.
 */
export function useGuideStage(stage: GoingStage, entry: GuideEntry | null, facts: GuideFacts, fresh: readonly string[], ready: boolean, stood: (id: string) => boolean) {
  const kept = stage.finished ?? [];
  const adding = fresh.filter(id => !kept.includes(id));
  const next = !ready ? undefined : adding.length ? { ...stage, finished: [...kept, ...adding] } : nextStage(stage, entry, closing(facts));
  const key = next && JSON.stringify(next);
  useEffect(() => { if (next) moveGuide(stage, next); }, [key]);
  // The step held, and the start of the guide it was held in: one started again (settings' "Show again") reads nothing
  // as done from before it.
  const held = useRef<{ entry: GuideEntry | null; at: number | null }>({ entry: null, at: null });
  const at = stage.stage === "started" ? stage.at : null;
  useEffect(() => {
    if (!ready) return;
    const restarted = at !== null && held.current.at !== at;
    const left = held.current.entry;
    if (!restarted && left && doneOnLeaving(left, entry, facts, stood(left.id))) putAway(left.id);
    held.current = { entry, at: at ?? held.current.at };
  }, [entry?.id, at, ready]);
}
