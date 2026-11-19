import { useEffect, useRef } from "react";
import { notify, shouldNotifyFailure } from "@/lib/notify";
import { readProblemText } from "@/data/client";
import type { IconName } from "@/components/ui/icon";
import { Message } from "@/components/ui/message";
import { useReadState, useWorkspaceInfo } from "@/data/queries";
import { resources } from "@/data/resources";
import { useConnection } from "@/data/connection";
import type { WorkspaceInfo } from "@/data/types";
import { minutesSince } from "@/domain/time";
import { formatGigabytes, formatPercent } from "@/domain/host";
import { useDialogStore } from "@/state/dialog-store";
import { useTranslation } from "react-i18next";
import { problemText } from "@/features/forms/problem-text";

/**
 * The one place the page says the workspace is not as it should be; while everything is read it draws
 * nothing (there is no footer to keep a status line in). Updates that do not come are the progress line's
 * (`ProgressLine`). One notice at a time, the one that matters most to what a person can do: a file that
 * cannot be read (and what that does to the screen), then cannot write for another reason, then the person's settings,
 * and last this machine being tight. A failed refresh of personal state uses the shared toast
 * while the previous values stay in use (`useReloadFailureToast`). Each says what happened in a few words and offers the one way out (no
 * explaining); the rest is in the diagnostics. Out of reach, a read again that failed is not told here: the progress
 * line says serve is out of reach, and the reads are made again once it is back.
 */
export function WorkspaceNotice() {
  const { t } = useTranslation("chrome");
  /** What is tight and for how long: "CPU 98% · 12m". */
  const hostDetail = (host: NonNullable<WorkspaceInfo["host"]>) => [
    ...host.kinds.map((kind) => kind === "cpu" ? t("notice.hostCpu", { value: formatPercent(host.cpu) })
      : kind === "memory" ? t("notice.hostMemory", { value: formatPercent(host.memoryFreePercent) })
      : t("notice.hostDisk", { value: formatGigabytes(host.diskFreeBytes) })),
    t("notice.hostMinutes", { count: Math.max(1, minutesSince(host.since, Date.now()) ?? 1) }),
  ].join(" · ");
  const info = useWorkspaceInfo();
  useReloadFailureToast(info.root);
  const diagnostics = () => useDialogStore.getState().open("diagnostics");
  // A file that cannot be read is told by its name: it is what to fix. While one cannot be read the server sends no
  // task and holds every write back, so the tasks on screen are the ones read before (`staleIds`), or none at all.
  const read = info.errors.length === 1 ? t("notice.unreadableOne", { path: info.errors[0]!.path || readProblemText(info.errors[0]!) }) : t("notice.unreadableMany", { count: info.errors.length });
  const readDetail = info.staleIds.length ? t("notice.shownFromBefore") : "";
  const notice: { icon: IconName | undefined; blocking: boolean; title: string; detail: string; action: string; onAction: () => void } | null =
    info.errors.length ? { icon: "file", blocking: !info.writable, title: read, detail: readDetail, action: t("notice.diagnostics"), onAction: diagnostics }
    : !info.writable ? { icon: undefined, blocking: true, title: t("notice.readOnly"), detail: "", action: t("notice.diagnostics"), onAction: diagnostics }
    : info.host ? { icon: undefined, blocking: false, title: t("notice.hostTight"), detail: hostDetail(info.host),
      action: t("notice.hostOpen"), onAction: () => useDialogStore.getState().open("settings", { tab: "host" }) }
    : null;
  if (!notice) return null;

  return <Message data-workspace-notice data-blocking={notice.blocking || undefined} live size="band" tone="caution"
    icon={notice.icon} className="mt-2" title={notice.title} description={notice.detail || undefined}
    action={{ label: notice.action, run: notice.onAction }} />;
}

/** A read again of the person's own state that failed while its last value stays in use: a toast with a way to try again. */
function useReloadFailureToast(root: string) {
  const { t } = useTranslation("chrome");
  const offline = useConnection((state) => state.offline);
  // A read again that failed while its last value is in use: the whole screen goes only for one never read (Workspace).
  const person = useReadState(resources.personalSettings(root).queryKey);
  const reads = useReadState(resources.notices(root).queryKey);
  const failedAgain = (read: typeof person) => !offline && !read.fetching && !!read.error && read.assessment.display && shouldNotifyFailure(read.error);
  const personal = [person, reads].filter(failedAgain);
  const reloadWords = personal.length === 2 ? { title: t("notice.reloadBoth"), previous: t("notice.previousBoth") }
    : personal[0] === person ? { title: t("notice.reloadSettings"), previous: t("notice.previousSettings") }
    : { title: t("notice.reloadReads"), previous: t("notice.previousReads") };
  const reloadFailure = personal.length ? { title: reloadWords.title,
    detail: [problemText(personal[0]!.error), reloadWords.previous].join(" "),
    retry: () => personal.forEach(read => read.retry()) } : null;
  // Read state owns the fallback and retry. notify alone owns its message and dismissal.
  const latestReload = useRef(reloadFailure);
  // The displayed failure and its action share their lifetime during a retry.
  if (!person.fetching && !reads.fetching) latestReload.current = reloadFailure;
  const id = `personal-read:${root}`;
  useEffect(() => () => notify.dismiss(id), [id]);
  useEffect(() => {
    // Keep the current failure while its retry is under way; a completed read settles it.
    if (person.fetching || reads.fetching) return;
    const failure = latestReload.current;
    if (!failure) { notify.dismiss(id); return; }
    notify.failure(personal[0]!.error, { id, ongoing: true, about: "reload personal state",
      text: failure.title, detail: failure.detail,
      action: { label: t("translation:retry"), run: () => latestReload.current?.retry() } });
  }, [id, offline, person.fetching, person.error, person.assessment.display,
    reads.fetching, reads.error, reads.assessment.display, t]);
}
