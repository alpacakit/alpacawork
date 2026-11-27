import { commandRoute } from "@alpacawork/contract/command-path";
import { automationHookResultSchema, automationInputResultSchema } from "@alpacawork/contract/automation";
import { automationEventKindSchema, automationEvents, automationWrittenEvent, automationProgramListResultSchema, automationProgramPreviewResultSchema, automationProgramRunReceiptSchema, automationProgramRunViewSchema,
  automationProgramRunsViewSchema, automationProgramViewResultSchema } from "@alpacawork/contract/automation-program";
import { z } from "zod";
import { useEffect } from "react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNow } from "@/state/clock";
import { api } from "@/data/resources";
import { ApiError } from "@/data/client";
import { workspaceWriteBasis } from "@/data/connection";
import { useWorkspaceInfo } from "@/data/queries";
import { useWorkspaceSelector } from "@/data/workspace-store";
import type { Task, TaskState } from "@/data/types";
import { useViewStore } from "@/state/view-store";
import { inProject } from "@/domain/automations";
import { toAutomation, toList, toPreviewResult, toRun, toRunDetail } from "./adapt";
import type { Automation, AutomationList, Preview, PreviewResult, Run } from "./shape";

/**
 * The automations as the server keeps them. Every read is keyed by the index's automations version, which moves with
 * any write of an automation or a run (whoever made it: this screen, the coordinator, the server running one), so a
 * moved version is a new read and the screen shows the latest without asking for it; the last answer stays on screen
 * while the next is read. A run names its tasks' states too, which move with the tasks, not the run: the reads that hold
 * runs are keyed by the made tasks' states as well (`useMadeTasks`).
 */
const RUNS_SHOWN = 50;

/**
 * The tasks automations made (of one automation, or of all), as the workspace's index has them now: each with its state,
 * in one string. It moves when one of them changes state, appears, or leaves the index as it finishes, so a read keyed
 * by it is read again then, as the list of tasks itself is.
 */
export const madeTasksKey = (tasks: readonly Pick<Task, "id" | "state" | "madeBy">[], automation: string | null): string =>
  tasks.flatMap(task => task.madeBy && (automation === null || task.madeBy.automationId === automation) ? [`${task.id}:${task.state}`] : []).join(" ");
function useMadeTasks(automation: string | null): string {
  return useWorkspaceSelector(data => madeTasksKey(data.tasks, automation));
}

/** The state of a task a run made, as the workspace's index has it now, or the run's record when the index no longer lists it. */
export function useMadeTaskState(task: Run["tasks"][number]): TaskState | null {
  const listed = useWorkspaceSelector(data => data.tasks.find(each => each.id === task.id)?.state);
  return listed ?? (task.state as TaskState | null);
}

/**
 * Every automation of every project (deleted ones left out), in the order they were made, with today's calls to an AI
 * and sends out of this PC: one read serves the table, the home's waiting rows and the face's dot.
 */
export function useAutomationList() {
  const root = useWorkspaceInfo(info => info.root), version = useWorkspaceInfo(info => info.automationsVersion);
  // Each one's last run names its tasks' states.
  const made = useMadeTasks(null);
  return useQuery<AutomationList>({ queryKey: ["automations", root, version, made], enabled: !!root, staleTime: Infinity, placeholderData: previous => previous,
    queryFn: ({ signal }) => api.request(commandRoute("automation/list"), automationProgramListResultSchema, signal).then(toList) });
}

/** The automations of the project in view (every project's when none is chosen). */
export function useAutomationsInView(): { automations: Automation[] | undefined; list: AutomationList | undefined; failed: unknown; retry: () => unknown } {
  const list = useAutomationList();
  const project = useViewStore(state => state.project);
  const projects = useWorkspaceInfo(info => info.projects);
  return { automations: list.data?.automations.filter(automation => inProject(automation.project, project, projects)), list: list.data,
    failed: list.error, retry: list.refetch };
}

/**
 * The automations in view that ask for a look (a run failed, it went off by itself, a new version waits to be turned
 * on), each with what asks and since when: the newest of its reasons.
 */
export function useAutomationsAttention(): { automation: Automation; kind: Automation["attention"][number]["kind"]; at: string }[] {
  const { automations } = useAutomationsInView();
  return (automations ?? []).flatMap(automation => {
    const first = attentionOf(automation);
    return first ? [{ automation, ...first }] : [];
  });
}
/** What one asks for a look for, the heaviest first: a failure, then going off, then a version to turn on. */
export function attentionOf(automation: Pick<Automation, "attention">) {
  const order = ["failed", "disabled", "stopping", "awaiting_enable"] as const;
  return [...automation.attention].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind))[0] ?? null;
}

/** One automation by its ID, deleted ones too (a task made by one names it after it is gone). */
export function useAutomation(id: string | null) {
  const root = useWorkspaceInfo(info => info.root), version = useWorkspaceInfo(info => info.automationsVersion);
  const made = useMadeTasks(id);
  return useQuery<Automation>({ queryKey: ["automation", root, id, version, made], enabled: !!root && id !== null, staleTime: Infinity,
    placeholderData: (previous, query) => query?.queryKey[2] === id ? previous : undefined, retry: false,
    queryFn: ({ signal }) => api.request(`${commandRoute("automation/get")}?automation=${encodeURIComponent(id!)}`, automationProgramViewResultSchema, signal)
      .then(answer => toAutomation(answer.automation)) });
}

/** The automation shown in its window, read whole (the list holds only what the table draws). */
export function useShownAutomation(id: string | null) {
  const read = useAutomation(id);
  return { automation: read.data, read };
}

/** The latest runs of one automation, newest first. */
export function useAutomationRuns(id: string) {
  const root = useWorkspaceInfo(info => info.root), version = useWorkspaceInfo(info => info.automationsVersion);
  const made = useMadeTasks(id);
  return useQuery<Run[]>({ queryKey: ["automation-runs", root, id, version, made], enabled: !!root, staleTime: Infinity,
    placeholderData: (previous, query) => query?.queryKey[2] === id ? previous : undefined,
    queryFn: ({ signal }) => readRuns(id, RUNS_SHOWN, signal) });
}
const readRuns = (id: string, limit: number, signal: AbortSignal) =>
  api.request(`${commandRoute("automation/runs")}?automation=${encodeURIComponent(id)}&limit=${limit}`, automationProgramRunsViewSchema, signal)
    .then(answer => answer.runs.map(run => toRun(id, run)));

/**
 * The latest runs of the automations in view, newest first. Across every project it is one read; with a project
 * chosen (the server reads no project apart), each automation's own latest runs are read and put together, so another
 * project's runs never crowd them out.
 */
export function useAllRuns(ids: readonly string[] | null) {
  const root = useWorkspaceInfo(info => info.root), version = useWorkspaceInfo(info => info.automationsVersion);
  const made = useMadeTasks(null);
  const all = useQuery<Run[]>({ queryKey: ["automation-runs", root, "all", version, made], enabled: !!root && ids === null, staleTime: Infinity, placeholderData: previous => previous,
    queryFn: ({ signal }) => api.request(`${commandRoute("automation/runs")}?limit=${RUNS_SHOWN}`, automationProgramRunsViewSchema, signal)
      .then(answer => answer.runs.map(run => toRun(run.automationId, run))) });
  const each = useQueries({ queries: (ids ?? []).map(id => ({ queryKey: ["automation-runs", root, id, "recent", version, made], enabled: !!root, staleTime: Infinity,
    queryFn: ({ signal }: { signal: AbortSignal }) => api.request(`${commandRoute("automation/runs")}?automation=${encodeURIComponent(id)}&limit=${RECENT_EACH}`,
      automationProgramRunsViewSchema, signal).then(answer => answer.runs.map(run => toRun(id, run))) })),
    combine: results => ({ error: results.find(result => result.error)?.error ?? null, refetch: () => results.forEach(result => void result.refetch()),
      data: results.every(result => result.data) ? results.flatMap(result => result.data!).sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, RUNS_SHOWN) : undefined }) });
  return ids === null ? { data: all.data, error: all.error, refetch: all.refetch } : each;
}
const RECENT_EACH = RUNS_SHOWN;

/** One run in full (what arrived, its operations, its report, the end of its output), read when a person opens it. */
export function useRunDetail(automation: string, run: Pick<Run, "number" | "version">, open: boolean) {
  const root = useWorkspaceInfo(info => info.root);
  // Keyed by the run's version, which moves with every write to it.
  return useQuery({ queryKey: ["automation-run", root, automation, run.number, run.version], enabled: !!root && open, staleTime: Infinity,
    queryFn: ({ signal }) => api.request(`${commandRoute("automation/run")}?automation=${encodeURIComponent(automation)}&number=${run.number}`,
      automationProgramRunViewSchema, signal).then(answer => toRunDetail(automation, answer.run, answer.event)) });
}

const pulledSchema = z.object({ files: z.array(z.object({ path: z.string(), source: z.string() })) });
/** A version's files with their text, read when a person opens the files. */
export function useVersionFiles(automation: string, digest: string, open: boolean) {
  const root = useWorkspaceInfo(info => info.root);
  return useQuery({ queryKey: ["automation-files", root, automation, digest], enabled: !!root && open, staleTime: Infinity,
    queryFn: ({ signal }) => api.request(`${commandRoute("automation/pull")}?automation=${encodeURIComponent(automation)}&version=${encodeURIComponent(digest)}`,
      pulledSchema, signal).then(answer => answer.files.map(file => ({ path: file.path, text: file.source }))) });
}

/** Reads the automations again now (the list and every one open), whatever version the index says. */
function rereadAutomations(client: ReturnType<typeof useQueryClient>, root: string) {
  for (const key of ["automations", "automation", "automation-runs"]) void client.invalidateQueries({ queryKey: [key, root] });
}

/**
 * What a person does to an automation from this screen. Turning on takes the latest version (and, when its AI's look
 * found something, says the person read it: `acknowledge`); dropping a new version puts back the one running.
 * Making its receiving URL and making it anew answer the automation, never the URL.
 */
export type AutomationAct = "enable" | "disable" | "delete" | "discard" | "hook-create" | "hook-rotate";
const ACT_COMMAND: Record<AutomationAct, string> = { enable: "enable", disable: "disable", delete: "delete", discard: "restore", "hook-create": "hook-create", "hook-rotate": "hook-rotate" };

/**
 * Sends one act. The answer is shown at once (the list and the one open take it), and the version's move reads
 * everything again. A refusal (it changed since it was read…) is said by the toast every failed write shows.
 */
export function useAutomationAct({ errorToast }: { errorToast?: false } = {}) {
  const client = useQueryClient();
  const root = useWorkspaceInfo(info => info.root);
  return useMutation({ meta: errorToast === false ? { errorToast } : undefined, onError: error => {
    // Refused because it changed since it was read: what it is now is read at once, to act on again.
    if (error instanceof ApiError && error.retry === "reread") rereadAutomations(client, root);
  }, mutationFn: async ({ act, automation, acknowledge }: { act: AutomationAct; automation: Pick<Automation, "id" | "hash" | "live">; acknowledge?: boolean }) => {
    const body = act === "disable" ? { automation: automation.id }
      : { automation: automation.id, expectedHash: automation.hash, ...act === "discard" ? { version: automation.live?.digest } : {}, ...acknowledge ? { acknowledgeReview: true } : {} };
    const answer = await api.request(commandRoute(`automation/${ACT_COMMAND[act]}`), automationProgramViewResultSchema, undefined, body, crypto.randomUUID(), workspaceWriteBasis());
    // Deleted, it leaves the list.
    if (act === "delete") {
      client.setQueriesData<AutomationList>({ queryKey: ["automations", root] }, list => list && { ...list, automations: list.automations.filter(item => item.id !== automation.id) });
      return null;
    }
    const saved = toAutomation(answer.automation);
    client.setQueriesData<AutomationList>({ queryKey: ["automations", root] }, list => list && { ...list,
      automations: list.automations.map(item => item.id === saved.id ? { ...saved, listed: true } : item) });
    client.setQueriesData<Automation>({ queryKey: ["automation", root, saved.id] }, () => saved);
    return saved;
  } });
}

/**
 * The next time it runs by the clock (on), or would (off): the first still ahead of the screen's clock. When the clock
 * has passed every one of them while the time is shown, they are read again.
 */
export function useUpcoming(automation: Pick<Automation, "next">, shown = true): string | null {
  const now = useNow(), client = useQueryClient();
  const root = useWorkspaceInfo(info => info.root);
  const upcoming = automation.next.find(at => Date.parse(at) > now) ?? null;
  const spent = shown && upcoming === null && automation.next.length > 0;
  useEffect(() => {
    if (!spent) return;
    rereadAutomations(client, root);
  }, [spent, client, root]);
  return upcoming;
}

/**
 * Showing it, first step: `trigger` alone, at one past event (the newest when none is chosen; a written one when the
 * person wrote it), and the events it can be shown at. Writing nothing, it runs whenever the event or the version moves.
 */
export function usePreview(automation: Pick<Automation, "id" | "latest">, event: string | null, written: string | null) {
  const root = useWorkspaceInfo(info => info.root);
  const digest = automation.latest.digest;
  return useQuery<PreviewResult>({ queryKey: ["automation-preview", root, automation.id, digest, event, written], enabled: !!root, staleTime: Infinity, retry: false,
    meta: { errorToast: false }, placeholderData: (previous, query) => query?.queryKey[2] === automation.id ? previous : undefined,
    // Showing runs `trigger`, which may ask an AI: the server takes it as a write, so it goes with the write basis.
    queryFn: () => api.request(commandRoute("automation/preview"), automationProgramPreviewResultSchema, undefined,
      { automation: automation.id, ...written !== null ? { syntheticEvent: writtenEvent(automation.latest.facts.when.event, written) } : event ? { event } : {} },
      crypto.randomUUID(), workspaceWriteBasis()).then(toPreviewResult) });
}

/**
 * The event a person wrote, as the server takes it: what a signal brings (its data alone, wrapped as one signal), or
 * for another kind the event's own fields, over the parts every event has.
 */
export function writtenEvent(kind: string, written: string): unknown {
  let value: unknown;
  try { value = JSON.parse(written); } catch { value = written; }
  return automationWrittenEvent(automationEventKindSchema.parse(kind), new Date().toISOString(), value);
}

/** What a person starts from when writing an event of a kind: the fields its event has, to fill in. */
export function eventTemplate(kind: string): string {
  return JSON.stringify(automationEvents[automationEventKindSchema.parse(kind)].example(new Date().toISOString()), null, 2);
}

/** Showing it, second step: `run` too, its writes replaced by what it would do. It may call an AI, so only on a press. */
export function usePreviewRun() {
  return useMutation({ meta: { errorToast: false }, mutationFn: async ({ automation, preview, written }: { automation: Pick<Automation, "id" | "latest">; preview: Preview; written: string | null }) => {
    return toPreviewResult(await api.request(commandRoute("automation/preview"), automationProgramPreviewResultSchema, undefined,
      { automation: automation.id, run: true, ...written !== null ? { syntheticEvent: writtenEvent(automation.latest.facts.when.event, written) } : { event: preview.event.ref } },
      crypto.randomUUID(), workspaceWriteBasis())).preview;
  } });
}

/** Doing it for real at the event shown (the showing's hash), as a trial: not counted toward its limits. */
export function useTry() {
  const client = useQueryClient();
  const root = useWorkspaceInfo(info => info.root);
  return useMutation({ meta: { errorToast: false }, onSettled: () => rereadAutomations(client, root), mutationFn: async ({ automation, preview }: { automation: string; preview: Preview }) =>
    toRun(automation, (await api.request(commandRoute("automation/try"), automationProgramRunReceiptSchema, undefined,
      { automation, previewHash: preview.hash }, crypto.randomUUID(), workspaceWriteBasis())).run) });
}

/** Stops one run where it is; once it has, the run says so. */
export function useRunStop() {
  const client = useQueryClient();
  const root = useWorkspaceInfo(info => info.root);
  return useMutation({ onSettled: () => rereadAutomations(client, root), mutationFn: async ({ automation, run }: { automation: string; run: Pick<Run, "number" | "version"> }) =>
    (await api.request(commandRoute("automation/run-stop"), z.unknown(), undefined,
      { automation, number: run.number, expectedRunVersion: run.version }, crypto.randomUUID(), workspaceWriteBasis())) });
}

/**
 * The URL of an automation's receiving point, read only for a person who opened it, and kept only while it is shown:
 * nothing holds it once the part showing it closes (`gcTime: 0`). Read anew for each version of the automation.
 */
export function useHookUrl(automation: Pick<Automation, "id" | "hash" | "hook">) {
  const root = useWorkspaceInfo(info => info.root);
  return useQuery({ queryKey: ["automation-hook", root, automation.id, automation.hash], enabled: !!root && automation.hook.exists,
    staleTime: 0, gcTime: 0, retry: false, meta: { errorToast: false },
    queryFn: ({ signal }) => api.request(`${commandRoute("automation/hook-read")}?automation=${encodeURIComponent(automation.id)}`, automationHookResultSchema, signal).then(answer => answer.url) });
}

/**
 * What a signal or the PC's pressure handed to a task a run made: read only when the person opens it. It is the
 * sender's material, never part of the instruction (the task's AI reads it by a command the same way).
 */
export function useRunInput(task: string | null) {
  const root = useWorkspaceInfo(info => info.root);
  return useQuery({ queryKey: ["automation-input", root, task], enabled: !!root && !!task, staleTime: Infinity,
    queryFn: ({ signal }) => api.request(`${commandRoute("automation/input")}?task=${encodeURIComponent(task!)}`, automationInputResultSchema, signal)
      .then(answer => answer.data) });
}
