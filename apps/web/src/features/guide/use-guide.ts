import { useEffect, useMemo, useRef, useState } from "react";
import { useIsMutating, useQueries } from "@tanstack/react-query";
import { z } from "zod";
import { useShallow } from "zustand/react/shallow";
import { useEveryTaskIndex, useListPlace, usePeople, useWorkspaceInfo } from "@/data/queries";
import { ApiError } from "@/data/client";
import { api } from "@/data/resources";
import { beforeWork } from "@/domain/before-work";
import { crewOf } from "@/domain/people";
import { useCoarsePointer } from "@/lib/input-capabilities";
import { PUSH_CHANGE, pushSupported } from "@/data/push";
import { recordFailure } from "@/lib/notify";
import { useDialogStore } from "@/state/dialog-store";
import { useDeviceValue } from "@/lib/device-storage";
import { useNarrow, useViewStore } from "@/state/view-store";
import { useConversation } from "@/features/coordinator/coordinator";
import { useInputDraft } from "@/features/coordinator/editor/draft";
import { hasContent, inlines } from "@/features/coordinator/editor/document";
import { outgoing } from "@/features/coordinator/editor/outbox";
import { graceReady } from "@/data/send-grace";
import { useDraftStore } from "@/features/forms/draft-store";
import { useSitting } from "@/features/reader/next-question";
import { readerOutcome } from "@/features/reader/submission";
import { useSubmittedTurns } from "@/features/reader/submitted-turns";
import type { Task } from "@/data/types";
import { going, guideStages, moveGuide, putAway, type GoingStage } from "./guide-state";
import { closing, doneOnLeaving, hasClose, stillReads, finishedHere, guideEntry, guideScreen, nextStage, saidBefore, startsGuide, turnKind, type GuideEntry, type GuideFacts,
  type GuideRead, type GuideScreen } from "./guide-definition";

const NO_TURNS: readonly CoordinatorTurn[] = [];
const NO_TASKS: readonly string[] = [];
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

/** This browser's own subscription, as last read: being read, the read failed, or read (held or not), with the permission then. */
export type SubscriptionRead = "reading" | "failed" | { permission: NotificationPermission; subscribed: boolean };
/**
 * Notifications are off on this browser, as it has itself made sure: it can receive them (`supported`), the person has
 * not blocked them, and its subscription was read and there is none. Anything not known (being read, a failed read) is
 * not off. Whether serve still lists a subscription held here is for Settings, not for the guide.
 */
export const pushOff = (supported: boolean, read: SubscriptionRead) =>
  supported && typeof read === "object" && read.permission !== "denied" && !read.subscribed;

/**
 * pushOff, read only while `enabled` (a step left reads it): as the screen opens, as each dialog closes (Settings is where
 * notifications are turned on), as starting or stopping them there ends (PUSH_CHANGE; not read while it runs), and as
 * the page comes back into view or into focus (changed in another tab or in the browser's settings). Each read starts
 * from not made sure (false), and only the read begun last is used: one made moot while the Service Worker is awaited
 * reads no subscription.
 */
function usePushOff(screen: GuideScreen, enabled: boolean): boolean {
  const dialog = useDialogStore((state) => state.dialog !== null);
  const changing = useIsMutating({ mutationKey: PUSH_CHANGE }) > 0;
  const [read, setRead] = useState<SubscriptionRead>("reading");
  const [looked, setLooked] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const back = () => { if (document.visibilityState === "visible") setLooked(count => count + 1); };
    document.addEventListener("visibilitychange", back);
    addEventListener("focus", back);
    return () => { document.removeEventListener("visibilitychange", back); removeEventListener("focus", back); };
  }, [enabled]);
  useEffect(() => {
    setRead("reading");
    if (!enabled || dialog || changing || !pushSupported()) return;
    // A read begun after this one, or the step put away (here, or in another tab as stored now: stillReads), makes this
    // one moot: then nothing more is read for it.
    let latest = true;
    navigator.serviceWorker.ready.then((registration) => latest && stillReads(screen, guideStages[screen].get(), "push") ? registration.pushManager.getSubscription().then((subscription) => {
      if (latest) setRead({ permission: Notification.permission, subscribed: subscription !== null });
    }) : undefined).catch((error: unknown) => { recordFailure(error, "push subscription read"); if (latest) setRead("failed"); });
    return () => { latest = false; };
  }, [screen, enabled, dialog, changing, looked]);
  return enabled && pushOff(pushSupported(), read);
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
 * Whose guide this screen shows (guideScreen): a computer's on a wide screen, a phone's on a narrow one touched (useNarrow,
 * the app's one rule for a phone's layout), none on a narrow one with a pointer. A computer's guide begun elsewhere keeps
 * its stage as it is, so it goes on once the screen is opened on a computer; on a phone the welcome says so (Welcome).
 */
export const useGuideScreen = (): GuideScreen | null => guideScreen(useNarrow(), useCoarsePointer());

/** This browser's guide of a screen while it goes on; null when it never started or is over (then nothing else is read for it). */
export const useGoingGuide = (screen: GuideScreen): GoingStage | null => going(useDeviceValue(guideStages[screen]));

/**
 * Starts each screen's guide by its own rule (startsGuide): read from the stored stages, the screen and the workspace's
 * counts alone, so a browser whose guide is over, or never starts, opens no draft and reads no conversation for it.
 * Mounted once, beside the balloon, so a stage is written by one owner only.
 */
export function useGuideStart() {
  const computer = useDeviceValue(guideStages.computer), phone = useDeviceValue(guideStages.phone);
  const opening = { screen: useGuideScreen(), welcome: useListPlace() === "welcome", tasks: useWorkspaceInfo((info) => info.counts.tasks.root ?? 0) };
  const starts = { computer: startsGuide("computer", computer, opening), phone: startsGuide("phone", phone, opening) };
  useEffect(() => { for (const screen of ["computer", "phone"] as const) if (starts[screen]) moveGuide(screen, null, { stage: "started", at: Date.now(), seen: [] }); },
    [starts.computer, starts.phone]);
}

/**
 * The step of a guide going on (guide-definition.ts), from what the screen already holds: the Tasks in the workspace,
 * its rows awaiting the person (a question, or a report) and those still worked on (and whether an AI is on them), what
 * the coordinator has from the person (coordinatorFacts), what the input holds, and whether the Task open in the detail
 * is the person's turn or being worked on. Only
 * mounted while the guide goes on: it opens the input's draft.
 */
export function useGuide(screen: GuideScreen, stage: GoingStage, skipped: ReadonlySet<string>, reads: ReadonlySet<GuideRead>): { entry: GuideEntry | null; again: boolean; facts: GuideFacts; fresh: readonly string[]; ready: boolean } {
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
  // Kept and read only where the guide has a close (hasClose): a phone's keeps none, and reads no Task for it.
  const closes = hasClose(screen);
  const fresh = closes ? doneBefore.current.fresh : NO_TASKS;
  // The Task seen in the detail: open there, and not under the card that says every turn is answered.
  const shown = useViewStore((state) => state.reader.open ? state.selected : null);
  const answeredAll = useSitting(state => state.emptied?.taskId ?? null);
  const selected = shown === answeredAll ? null : shown;
  // The rows awaiting the person, and which of them is seen in the detail (awaiting).
  const { submitted, finishing } = useSubmittedTurns();
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
  const leaving = useMemo(() => outgoing(entries, root)
    .filter(item => !item.taken && !item.cancelled && item.stage !== "refused" && !turns.some(turn => turn.id === item.requestId)), [entries, root, turns]);
  const sending = useMemo(() => leaving.map(item => item.requestId), [leaving]);
  // Still within the moment it can be taken back in (it leaves that stage as the moment ends, which redraws this).
  const soon = leaving.some(item => item.stage === "queued" && !graceReady(item.due));
  // What the input holds now: anything to send (foundDraft), and a label.
  const { doc } = useInputDraft();
  const found = useRef<FoundDraft>(null);
  found.current = foundDraft(stage, JSON.stringify(doc), found.current);
  const drafting = hasContent(doc) && !found.current?.same;
  const labelled = inlines(doc).some(node => node.type === "taskLabel");
  // Settings hold the app and phone steps wherever the pointer is not a touch (SettingsDialog).
  const apps = !useCoarsePointer();
  // Read only while a step left reads it (stepsLeft).
  const pushOffHere = usePushOff(screen, reads.has("push"));
  const seen = useMemo(() => new Set(stage.seen), [stage]);
  const coordinator = coordinatorFacts({ since: stage.stage === "started" ? stage.at : null, turns, sending });
  const conversationOpen = useConversation(state => state.expanded);
  const pressed = closes ? [...new Set([...stage.finished ?? [], ...fresh])] : NO_TASKS;
  const finished = finishedHere(pressed, useServerState(pressed, index.byId));
  const doneHere = finished.length > 0;
  // Done pressed on a row still awaiting the person, as this device keeps that press (a load of the page does not lose
  // it; taken back, it is no longer kept): on its way until the server says the Task is finished.
  const settling = rows.some(row => { const task = row.section === "review" ? index.byId.get(row.taskId) : undefined; return !!task && finishing(task); });
  // The step standing on this page in its first words, as it was last chosen: it goes on in them while it holds.
  const standing = useRef<string | null>(null);
  const facts: GuideFacts = { screen, stage, tasks, doneHere, settling, questions, results, working, unowned, ...coordinator, soon, conversationOpen, labelled, drafting, open,
    pushOff: pushOffHere, apps, seen, skipped, standing: standing.current };
  // Until the conversation is read, what the coordinator has and what the input holds are not known: no step is chosen.
  const ready = useConversation(state => state.conversation !== null);
  const entry = ready ? guideEntry(facts) : null;
  const again = !!entry && saidBefore(entry, facts);
  if (ready) standing.current = entry && !again ? entry.id : null;
  return { entry, again, facts, fresh, ready };
}

/**
 * Stores the stage as a guide going on moves (nextStage), only over the stage it was decided on (moveGuide): the Tasks
 * Done was pressed on since it began (`fresh`, kept as `finished` whatever step shows), and puts away a step with a
 * button as the guide moves on from it (doneOnLeaving; `stood`: its balloon has stood on this page). Nothing is stored
 * while the guide is not `ready`. Mounted once, beside the balloon, so a stage is written by one owner only.
 */
export function useGuideStage(screen: GuideScreen, stage: GoingStage, entry: GuideEntry | null, facts: GuideFacts, fresh: readonly string[], ready: boolean, stood: (id: string) => boolean) {
  const kept = stage.finished ?? [];
  const adding = fresh.filter(id => !kept.includes(id));
  const next = !ready ? undefined : adding.length ? { ...stage, finished: [...kept, ...adding] } : nextStage(stage, entry, closing(facts));
  const key = next && JSON.stringify(next);
  // Tried again whenever what is stored changes: a move refused because another tab stored something meanwhile is
  // made over what that tab stored.
  const from = JSON.stringify(stage);
  useEffect(() => { if (next) moveGuide(screen, stage, next); }, [key, from]);
  // The step held, and the start of the guide it was held in: one started again (settings' "Show again") reads nothing
  // as done from before it.
  const held = useRef<{ entry: GuideEntry | null; at: number | null }>({ entry: null, at: null });
  const at = stage.stage === "started" ? stage.at : null;
  useEffect(() => {
    if (!ready) return;
    const restarted = at !== null && held.current.at !== at;
    const left = held.current.entry;
    if (!restarted && left && doneOnLeaving(left, entry, facts, stood(left.id))) putAway(screen, left.id);
    held.current = { entry, at: at ?? held.current.at };
  }, [entry?.id, at, ready]);
}
