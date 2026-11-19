import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { indexPeople } from "@/domain/people";
import { useWorkspace } from "./feed";
import { useReadState } from "./queries";
import { createWorkspaceStore, publishWorkspace, WorkspaceContext, type WorkspaceData, type WorkspaceStore } from "./workspace-store";
import { mapWorkspace } from "./map";
import { receiveServerFacts, useReadStore } from "../state/read-store";
import { usePersonalSettings } from "./personal-settings";
import { resources } from "./resources";
import { useApplyTheme } from "@/state/theme";
import { useServerReadFacts, useDisplayReadFacts } from "./use-read-facts";
import { conversationHeldByRelease, useConversation } from "@/features/coordinator/coordinator";
import { Message } from "@/components/ui/message";
import { readFailureReason } from "@/components/ui/loadable";
import { HeldPage, UpdateConfirmDialog, UpdateStateLine } from "@/features/update/UpdateView";
import { useUpdateStatus, type UpdateStatus } from "@/features/update/update-state";
import { fromOtherVersion, heldByRelease, unreachable } from "./client";

const HELD_RETRY_MS = 10_000;
/** The page is opened again by itself for a new version at most once a minute: a page that still does not match says so. */
const VERSION_RELOAD_KEY = "alpacawork:reloaded-for-version";
const VERSION_RELOAD_MS = 60_000;
/** Opens the page again for serve's new version, unless it was just done (the reload did not bring a matching page). */
function reloadForVersion(): boolean {
  try {
    const last = Number(sessionStorage.getItem(VERSION_RELOAD_KEY) ?? 0);
    if (Date.now() - last < VERSION_RELOAD_MS) return false;
    sessionStorage.setItem(VERSION_RELOAD_KEY, String(Date.now()));
  } catch { return false; } // No storage to stop a loop with: the person reloads.
  location.reload();
  return true;
}
/** An update that holds the workspace until it goes on: under way, or stopped and needing the person. */
const heldByUpdate = (status: UpdateStatus) => status.kind === "applying" || status.kind === "recovering" || status.kind === "fetching"
  || status.kind === "attention";

/** The frame is drawn as soon as language and theme are known; what it shows from the index follows the projection. */
export function Workspace({ children }: { children: ReactNode }) {
  useApplyTheme();
  const client = useQueryClient();
  const { t } = useTranslation("panels");
  const feed = useWorkspace();
  const server = useServerReadFacts();
  const { index, restoredAt } = useDisplayReadFacts();
  useEffect(() => {
    if (index) useReadStore.getState().bind(index.root);
    if (server) receiveServerFacts(server);
  }, [index?.root, server]);
  // Only what the projection reads, so a periodic reload that finds nothing new does not redraw the workbench.
  const baseline = useReadStore(useShallow(({ root, status, checkpoint, reads, firstSeen }) => ({ root, status, checkpoint, reads, firstSeen })));
  const root = feed.data?.root ?? null;
  const personStatus = usePersonalSettings((state) => state.status);
  const personError = usePersonalSettings((state) => state.loadError);
  const noticeRead = useReadState(resources.notices(root ?? "").queryKey);
  const loadPerson = usePersonalSettings((state) => state.load);
  const update = useUpdateStatus();
  // The coordinator's conversation is read again when the index says it changed (a turn queued, started or answered,
  // here or on another screen), once it has been read: opened, or still followed for its unread answer.
  // Its workspace is set before its first read: an answer is shown only in the workspace it was asked in.
  const coordinator = feed.data?.person.coordinator;
  useEffect(() => { if (root) useConversation.setState({ root, wanted: false }); }, [root]);
  useEffect(() => { if (root) useConversation.getState().follow(); }, [root, feed.data?.generation, coordinator?.id, coordinator?.revision]);
  const previousPeople = useRef<ReturnType<typeof indexPeople> | null>(null);
  const people = useMemo(() => {
    if (!index) return null;
    return previousPeople.current = indexPeople(index, previousPeople.current ?? undefined);
  }, [index]);
  const news = useRef<Pick<WorkspaceData, 'events' | 'readIds'> | null>(null);
  const data = useMemo(() => {
    if (!index || !people || !baseline.checkpoint || baseline.root !== index.root
      || personStatus !== "ready") return null;
    const mapped = mapWorkspace(index, { checkpoint: baseline.checkpoint, reads: baseline.reads, firstSeen: baseline.firstSeen }, server, news.current ?? undefined);
    if (server || !news.current) news.current = { events: mapped.events, readIds: mapped.readIds };
    return { ...mapped, ...news.current,
      people, drawing: { root: index.root, restoredAt },
      info: { root: index.root, rev: index.rev, writable: index.writable, errors: index.errors, staleIds: index.staleIds, runs: index.runs, profiles: index.profiles, attachmentBytes: index.attachmentBytes,
        projects: index.projects, presence: index.presence, host: index.host, coordinatorWork: index.coordinatorWork,
        counts: index.counts, home: index.home, checkpointAt: baseline.checkpoint.at } };
  }, [index, restoredAt, server, baseline, people, personStatus]);
  // What the screen cannot be drawn without, not read at first: the whole screen says so.
  // An update whose switch has not ended holds the workspace: nothing else is read until it goes on, so its line (and
  // the one press it offers) is shown here, the only place left; with no update under way the line is empty.
  const failed = personStatus === "error" || baseline.status === "error";
  // Refused because an update's switch holds the workspace: the page is that update's, whether or not its status has
  // been read yet (the serve may be restarting in the switch), and whether or not earlier reads are still shown.
  const refused = { person: heldByRelease(personError), reads: heldByRelease(noticeRead.error) };
  const held = refused.person || refused.reads;
  // Why the page cannot be drawn, by its one way back: serve is another version (the page is opened again), serve does
  // not answer yet (it is asked again until it does), or a failure the person may retry.
  const failures = [personStatus === "error" ? personError : undefined, baseline.status === "error" ? noticeRead.error : undefined]
    .filter((error) => error !== undefined);
  const stop: Stop = failures.some(fromOtherVersion) ? "version" : failures.length && failures.every(unreachable) ? "unreachable" : "failed";
  const waiting = held || failed && stop === "unreachable";
  const [reloading, setReloading] = useState(false);
  useEffect(() => { if (failed && !held && stop === "version" && !reloading) setReloading(reloadForVersion()); }, [failed, held, stop, reloading]);
  /** What keeps this page up, or was refused for the update, read again: the person's settings and the reads. */
  const retryReads = () => {
    if (root && (personStatus === "error" || refused.person)) void loadPerson(root);
    if (baseline.status === "error") void useReadStore.getState().reload();
    else if (refused.reads) noticeRead.retry();
  };
  // After a hold: once the switch ended with what it refused still failing, that is read again by itself, once; once
  // the page reads again (not while its reads are only being asked again), the conversation it refused is read again
  // too, once (it has its own retries meanwhile).
  const afterHold = useRef<"none" | "held" | "retried">("none");
  const endedKind = useRef<string | null>(null);
  useEffect(() => {
    // Held, and the status now says the switch ended (read as anything but under way or needing the person): what it
    // refused is read again at once, once per such status.
    if (held && update.kind !== "none" && !heldByUpdate(update) && endedKind.current !== update.kind) { endedKind.current = update.kind; retryReads(); }
    if (heldByUpdate(update)) endedKind.current = null;
    if (held) { afterHold.current = "held"; return; }
    if (afterHold.current === "none") return;
    if (afterHold.current === "held" && failed && !heldByUpdate(update)) { afterHold.current = "retried"; retryReads(); return; }
    if (!failed && !held && personStatus === "ready") {
      afterHold.current = "none";
      if (conversationHeldByRelease()) useConversation.getState().retry();
    }
  });
  // The switch may end without the status saying how (put back, it still asks for the person): while held, what keeps
  // this page up is asked again now and then, so the workspace comes back as soon as the release lets it be read.
  const latestRetry = useRef(retryReads);
  latestRetry.current = retryReads;
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => latestRetry.current(), HELD_RETRY_MS);
    return () => clearInterval(timer);
  }, [waiting]);
  if (failed || held) return <main className="min-h-screen grid place-items-center px-6">
    <div className="flex w-full max-w-md flex-col items-center gap-4">{held ? <HeldPage /> : stop !== "version" && <UpdateStateLine />}<UpdateConfirmDialog />
    {!held && (stop === "version" ? <Message size="page" tone="info" live title={t("workspaceStop.updated")}
        description={reloading ? t("workspaceStop.reloading") : `${t("workspaceStop.reloadHint")} ${t("update.resumeHint")}`}
        action={reloading ? undefined : { label: t("update.reload"), run: () => location.reload() }} />
      : stop === "unreachable" ? <Message size="page" tone="waiting" live title={t("workspaceStop.unreachable")} description={t("workspaceStop.unreachableWait")} />
      : <Message size="page" tone="error" title={t("workspaceStop.failed")} description={readFailureReason(failures[0]) || t("workspaceStop.failedHint")}
        action={{ label: t("translation:retry"), run: retryReads }} />)}</div>
  </main>;
  return <WorkspaceProvider data={data}>{children}</WorkspaceProvider>;
}

type Stop = "version" | "unreachable" | "failed";

/** The store is made with the first projection and follows it; while there is none the frame waits without it. */
function WorkspaceProvider({ data, children }: { data: WorkspaceData | null; children: ReactNode }) {
  const [store, setStore] = useState<WorkspaceStore | null>(null);
  if (!data !== !store) setStore(data ? createWorkspaceStore(data) : null);
  useLayoutEffect(() => { if (store && data) publishWorkspace(store, data); }, [store, data]);
  return <WorkspaceContext value={store}>{children}</WorkspaceContext>;
}
