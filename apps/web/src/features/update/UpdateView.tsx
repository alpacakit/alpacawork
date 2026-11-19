/**
 * The update's places on the screen: a mark on the gear, one status line under the settings' title with at most one
 * action (a version to start is a state like the others: its line names it and offers Update), a short confirmation,
 * and the version at the settings' foot. There is no update tab. Each draws the one projection (`useUpdateStatus`).
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { ConsequenceNote } from "@/components/ui/consequence-note";
import { Message } from "@/components/ui/message";
import { Dialog, DialogBody, DialogClose, DialogContent, DialogFooter, DialogHeading } from "@/components/ui/dialog";
import { Icon, type IconName } from "@/components/ui/icon";
import { APP_VERSION } from "@/lib/app-version";
import { cn } from "@/lib/utils";
import { CopyButton } from "@/components/ui/copy-button";
import { textClip } from "@/lib/clipboard";
import { approveStart, continueUpdate, postponeUpdate, pressUpdate, retryUpdate, useUpdateLocal, useUpdateStatus, useWaitingForUpdate,
  type Confirmation, type UpdateStatus } from "./update-state";

const CUT = "ring-2 ring-[color:var(--bg)]";
/**
 * A press whose answer has not come: the button looks and acts disabled but keeps the focus it has (a disabled button
 * drops the keyboard's focus out of the dialog), so the next Tab goes on from it.
 */
const BUSY_PRESS = "aria-disabled:cursor-default aria-disabled:opacity-38";
/** What the page an update holds is about: the switch under way, or stopped and needing the person. */
const HOLDS = new Set<UpdateStatus["kind"]>(["fetching", "applying", "recovering", "attention"]);
/** Under way: fetched, waiting for Runs, being switched to, or being recovered. */
const BUSY = new Set<UpdateStatus["kind"]>(["fetching", "waiting", "applying", "recovering"]);
const AT = "absolute -right-1.5 -top-1.5 inline-flex size-[11px] items-center justify-center rounded-full";
/**
 * The gear's mark, at its top right, clear of the person's dot at the foot of the icon beside it, says by shape:
 * ↓ an update to start (what comes down to this place), a ring one under way (fetched, waiting, being switched to or
 * recovered), ! one that failed or needs attention, ↻ a new version running that this page shows once loaded again;
 * none otherwise.
 */
export function UpdateMark() {
  const kind = useUpdateStatus().kind;
  if (kind === "available") return <span aria-hidden="true" data-update-mark="available" className={cn(AT, CUT, "bg-new")}>
    <Icon name="arrowDown" className="size-[9px] text-bg" strokeWidth={3} /></span>;
  if (BUSY.has(kind)) return <span aria-hidden="true" data-update-mark="busy" className={cn(AT, CUT, "border-2 border-new bg-[color:var(--bg)]")} />;
  if (kind === "done") return <span aria-hidden="true" data-update-mark="done" className={cn(AT, CUT, "bg-new")}>
    <Icon name="reload" className="size-[9px] text-bg" strokeWidth={3} /></span>;
  if (kind === "failed" || kind === "attention") return <span aria-hidden="true" data-update-mark={kind} className={cn(AT, CUT, "bg-warn")}>
    <Icon name="warn" className="size-[9px] text-bg" strokeWidth={3} /></span>;
  return null;
}
/** The gear's name, with what its mark says (its tooltip on a PC). */
export function useGearLabel() {
  const { t } = useTranslation("chrome");
  const status = useUpdateStatus(), kind = status.kind;
  return kind === "available" ? t("appBar.settingsUpdate.available", { version: status.version }) : BUSY.has(kind) ? t("appBar.settingsUpdate.busy")
    : kind === "failed" ? t("appBar.settingsUpdate.failed") : kind === "attention" ? t("appBar.settingsUpdate.attention")
    : kind === "done" ? t("appBar.settingsUpdate.done") : t("appBar.settings");
}

/** Where a published version's notes are: what it changes and what to check before installing it. */
export const releaseNotesUrl = (version: string) => `https://github.com/alpacakit/alpacawork/releases/tag/v${encodeURIComponent(version)}`;

/**
 * `long`: a sentence with its next step; on a phone its button goes under it so the words keep the line's width.
 * `notes`: the version whose release notes the line links to.
 * `pause`: the version a pause instruction is for, offered to copy and send the coordinator while agents keep it waiting.
 */
type Line = { icon: IconName; text: string; warn?: boolean; long?: boolean; notes?: string; pause?: string;
  action?: { label: string; run: () => void; primary?: boolean } | null };
/** What the person decides on now, in one phrase, and the one press that then applies (or none). */
function useLine(status: UpdateStatus, held: boolean): Line | null {
  const { t } = useTranslation("panels");
  // On the page an update holds, a status not read yet, or one that no longer says the switch (it ended, the reads
  // not yet back), says what the page waits for: nothing to press there until the workspace is back.
  if (held && !HOLDS.has(status.kind)) return { icon: "doing", text: t("update.held.unread") };
  switch (status.kind) {
    case "none": return null;
    case "available": {
      // A version that changes the execution FORMAT or the database is refused while agents work: said before any press,
      // and offered once none is (the status is read again every 30 s meanwhile).
      const later = status.requiresNoRuns && status.runs > 0;
      const offered = later ? t("update.line.availableAfterRuns", { version: status.version, count: status.runs })
        : t("update.line.available", { version: status.version, current: APP_VERSION });
      return { icon: later ? "info" : "arrowDown", long: later, notes: status.version, pause: later ? status.version : undefined,
        text: status.note?.kind === "withdrawn" ? `${t("update.line.withdrawn", { version: status.note.version })} ${offered}` : offered,
        action: later ? null : { label: t("update.start"), run: () => void pressUpdate(status), primary: true } };
    }
    case "fetching": return { icon: "doing", text: t("update.line.fetching", { version: status.version }) };
    case "waiting": return { icon: "doing", text: t("update.line.waiting", { count: status.runs }),
      action: { label: t("update.postpone"), run: () => void postponeUpdate(status.opId) } };
    case "failed": return { icon: "error", warn: true, long: !!status.runConflict, pause: status.runConflict ? status.version : undefined,
      text: status.runConflict ? t("update.line.runsActive", { count: status.runConflict.runs, version: status.version })
        : status.category === "network" ? t("update.line.failedNetwork", { version: status.version })
        : status.category === "disk" ? t("update.line.failedDisk", { version: status.version }) : t("update.line.failed", { version: status.version }),
      action: { label: t("update.retry"), run: () => void retryUpdate(status) } };
    case "withdrawn": return { icon: "info", text: t("update.line.withdrawn", { version: status.version }) };
    // Accepted: nothing to put off or try again, only followed until it ends.
    case "applying": return { icon: "doing", text: t("update.line.applying", { version: status.version }) };
    case "recovering": return { icon: "doing", text: t("update.line.recovering", { version: status.version }) };
    // Stopped and needing the person: it goes on with the same operation (why it stopped stays in the release's logs).
    case "attention": return { icon: "error", warn: true, long: true, action: { label: t("update.continue"), run: () => void continueUpdate(status) },
      text: status.version !== null ? t("update.line.attention", { version: status.version }) : t("update.line.attentionUnknown") };
    // Its words say to everyone to ask for a resume: the screen does not know whether agents were paused for it.
    case "done": return { icon: "done", long: true, text: t("update.line.done"), action: { label: t("update.reload"), run: () => location.reload(), primary: true } };
    default: return null;
  }
}

/**
 * Under the title row, above the tabs (or alone on the page an update holds, `held`): one always-present live line
 * whose words are replaced, and its one action.
 */
export function UpdateStateLine({ held = false }: { held?: boolean }) {
  const status = useUpdateStatus(), sending = useUpdateLocal((local) => local.sending);
  const line = useLine(status, held);
  return <div data-update-line className={cn("flex flex-wrap items-center gap-x-3 gap-y-1", line && "mb-3")}>
    <p role="status" aria-live="polite" data-update-state className={cn("m-0 flex min-w-0 flex-1 basis-48 items-start gap-1.5 text-sm", line?.long && "narrow:basis-full", line?.warn ? "text-warn" : "text-muted")}>
      {line && <><Icon name={line.icon} className="mt-0.5 flex-none" /><span className="min-w-0 [overflow-wrap:anywhere] [word-break:auto-phrase]">{line.text}
        {line.notes && <> <ReleaseNotes version={line.notes} /></>}</span></>}
    </p>
    {line?.action && <Button data-update-action variant={line.action.primary ? "default" : "outline"} className={cn("flex-none narrow:min-h-11", BUSY_PRESS)}
      aria-disabled={sending || undefined} onClick={() => { if (!sending) line.action!.run(); }}>{line.action.label}</Button>}
    {line?.pause && <PauseInstruction version={line.pause} />}
  </div>;
}

/**
 * The words that ask the coordinator to pause working agents at a good point (hold their tasks, let running ones finish
 * their turn), to paste into its input: copied, not put into the input, so a draft there is never touched. Once none
 * works, the line offers Update by itself.
 */
function PauseInstruction({ version }: { version: string }) {
  const { t } = useTranslation("panels");
  return <CopyButton words label={t("update.copyPause")} clip={() => textClip(t("update.pauseInstruction", { version }))} />;
}

function ReleaseNotes({ version }: { version: string }) {
  const { t } = useTranslation("panels");
  return <a data-update-notes href={releaseNotesUrl(version)} target="_blank" rel="noreferrer" className="whitespace-nowrap">{t("update.notes")}</a>;
}

/** Mounted only while open, so the dialog records the button that opened it and gives the focus back there. */
export function UpdateConfirmDialog() {
  const confirmation = useUpdateLocal((local) => local.confirm);
  if (!confirmation) return null;
  // One opening per confirmation: its checkbox lives as long as this opening, so an edit cancelled here is gone at the next.
  return <StartConfirmation key={confirmation.reviewDigest} confirmation={confirmation} />;
}
const close = (next: boolean) => { if (!next) useUpdateLocal.setState({ confirm: null }); };

/**
 * The one confirmation: from which version to which and where its notes are, what pressing does (the agents working
 * now go on, or this version switches only while none works), that there is no going back, and which skills are
 * overwritten.
 */
function StartConfirmation({ confirmation }: { confirmation: Confirmation }) {
  const { t } = useTranslation("panels");
  const [showNextTime, setShowNextTime] = useState(true);
  return <Dialog open onOpenChange={close}>
    <DialogContent data-update-confirm>
      <DialogHeading title={<span className="[word-break:auto-phrase]">{t("update.confirm.title", { version: confirmation.version })}</span>} />
      <DialogBody>
        {confirmation.changes && confirmation.changes.length > 0 && <ul className="m-0 flex list-disc flex-col gap-1 pl-5 text-base">
          {confirmation.changes.map((change) => <li key={change}>{change}</li>)}
        </ul>}
        <p data-update-from className="m-0 text-base">{t("update.confirm.from", { current: APP_VERSION, version: confirmation.version })}{" "}
          <ReleaseNotes version={confirmation.version} /></p>
        <p data-update-body className="m-0 mt-type-block text-sm text-muted [word-break:auto-phrase]">
          {confirmation.requiresNoRuns ? t("update.confirm.bodyNoRuns") : confirmation.runs > 0 ? t("update.confirm.bodyRuns", { count: confirmation.runs })
            : t("update.confirm.body")} {t("update.confirm.noReturn", { current: APP_VERSION })}</p>
        {confirmation.skills.length > 0 && <ConsequenceNote><span data-update-overwrite>
          {t("update.confirm.overwrite", { count: confirmation.skills.length, skills: confirmation.skills })}</span></ConsequenceNote>}
        <label className="mt-type-block flex cursor-pointer items-center gap-2 text-sm">
          <input type="checkbox" checked={showNextTime} onChange={(event) => setShowNextTime(event.target.checked)} className="size-5 cursor-pointer accent-ink" />
          {t("update.confirm.showNextTime")}
        </label>
        <DialogFooter>
          <DialogClose asChild><Button variant="outline">{t("update.confirm.cancel")}</Button></DialogClose>
          <Button data-update-submit onClick={() => void approveStart(confirmation, showNextTime)}>{t("update.start")}</Button>
        </DialogFooter>
      </DialogBody>
    </DialogContent>
  </Dialog>;
}

/**
 * The page an update holds (nothing else can be read meanwhile), as the shared page message: what the switch is doing,
 * that the screen comes back once it ends (unless it stopped and needs the person), its one press, and which app this
 * is. Read every 3 s while shown.
 */
export function HeldPage() {
  const { t } = useTranslation("panels");
  useWaitingForUpdate();
  const status = useUpdateStatus(), sending = useUpdateLocal((local) => local.sending);
  const line = useLine(status, true);
  if (!line) return null;
  return <div className="flex w-full flex-col items-center gap-3">
    <Message size="page" live tone={line.warn ? "error" : line.icon === "doing" ? "waiting" : "info"}
      title={<span data-update-state>{line.text}</span>} description={status.kind !== "attention" ? t("update.held.wait") : undefined}
      action={line.action ? { label: line.action.label, run: line.action.run, busy: sending, data: { "data-update-action": "" } } : undefined} />
    <p data-version-line className="m-0 text-xs text-muted">alpacawork {APP_VERSION}</p>
  </div>;
}

/** Settings' foot: the version this page runs, small and muted, the same on every tab. */
export function VersionLine() {
  return <p data-version-line className="mt-8 mb-0 text-xs text-muted">alpacawork {APP_VERSION}</p>;
}
