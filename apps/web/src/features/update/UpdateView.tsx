/**
 * The update's places on the screen: a mark on the gear (and on Settings' Update), the one card that says where an
 * update stands in every state with at most its presses (Settings' Update, the page an update holds, the stopped
 * workspace), a short confirmation, and the version at the settings' foot. Each draws the one projection
 * (`useUpdateStatus`).
 */
import { useState } from "react";
import { SKILL_OFFERS } from "@alpacawork/contract";
import { useSkills } from "@/data/skills";
import { useDialogStore } from "@/state/dialog-store";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { ConsequenceNote } from "@/components/ui/consequence-note";
import { Message } from "@/components/ui/message";
import { RegionSkeleton } from "@/components/ui/skeleton";
import { Dialog, DialogBody, DialogClose, DialogContent, DialogFooter, DialogHeading } from "@/components/ui/dialog";
import { Icon, type IconName } from "@/components/ui/icon";
import { APP_VERSION } from "@/lib/app-version";
import { cn } from "@/lib/utils";
import { CopyButton } from "@/components/ui/copy-button";
import { TextMark } from "@/components/ui/text-mark";
import { textClip } from "@/lib/clipboard";
import { approveStart, continueUpdate, postponeUpdate, pressUpdate, retryUpdate, updateHasNews, useReloadHolds, useUpdateLocal, useUpdateStatus, useUpdateStatusKnown, useUpdateTargets, useWaitingForUpdate,
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
 * The page an update holds (nothing else can be read meanwhile): the update's card, as Settings shows it, and which
 * app this is. A status not read yet, or one that no longer says the switch (it ended, the reads not yet back), says
 * what the page waits for. Read every 3 s while shown.
 */
export function HeldPage() {
  const { t } = useTranslation("panels");
  useWaitingForUpdate();
  const status = useUpdateStatus();
  return <div className="flex w-full flex-col items-center gap-3">
    {HOLDS.has(status.kind) ? <div className="w-full text-start"><UpdateCard /></div>
      : <Message size="page" live tone="waiting" title={t("update.held.unread")} description={t("update.held.wait")} />}
    <p data-version-line className="m-0 text-xs text-muted">alpacawork {APP_VERSION}</p>
  </div>;
}

/** Settings' foot: the version this page runs, small and muted, the same on every tab. */
export function VersionLine() {
  return <p data-version-line className="mt-8 mb-0 text-xs text-muted">alpacawork {APP_VERSION}</p>;
}

/** Whether the gear's mark asks for the person: the settings then open on Update, where it is read and pressed. */
/** Whether Update's place in the settings carries the gear's mark: something there waits for the person. */
export const useUpdateMarked = () => updateHasNews(useUpdateStatus());
/** What pressing the gear opens: Update while its mark shows something, else the section last open. */
export function useOpenSettingsFromGear() {
  const status = useUpdateStatus();
  return () => useDialogStore.getState().open("settings", updateHasNews(status) ? { tab: "update" } : undefined);
}

/**
 * Settings' Update: the one place the app's update is read and done. On top, where this PC stands: a new version
 * offered (from which to which, its release notes, the one press), the latest running, or the switch under way or
 * needing the person. Under it, everything an update replaces, by name: alpacawork itself
 * and each skill that comes with it, so none of them is looked for or updated on its own.
 */
export function UpdateSettingsTab() {
  const { t } = useTranslation("panels");
  const { t: setup } = useTranslation("setup");
  const status = useUpdateStatus(), known = useUpdateStatusKnown();
  const skills = useSkills().data?.skills;
  const latest = !updateHasNews(status);
  // The version an update offered or under way brings, whatever its state; none once it is running or none is offered.
  const next = !latest && status.kind !== "done" && "version" in status ? status.version : null;
  // What a candidate replaces is what its confirmation names; with none offered, what this PC has that comes with alpacawork.
  const targets = useUpdateTargets("candidateId" in status ? status.candidateId : null)
    ?? (skills ? ["alpacawork", ...SKILL_OFFERS.filter(offer => offer.from.kind === "bundled" && skills.find(each => each.name === offer.name)?.installed).map(offer => offer.name)] : null);
  const skillTitle = (name: string) => name === "alpacawork" ? t("update.page.appSkill")
    : SKILL_OFFERS.some(offer => offer.name === name) ? setup(`skills.items.${name}.title`) : null;
  // A skill reads as Recommended skills shows it: what it is for, then its name, the one that is in the skills folder.
  const items = [{ key: "app", title: t("update.page.app"), isSkill: false, name: null },
    ...(targets ?? []).map(name => { const title = skillTitle(name); return { key: name, title: title ?? name, isSkill: true, name: title ? name : null }; })];
  if (!known) return <RegionSkeleton shape="settingRows" rows={4} />;
  return <div data-settings-update className="space-y-8">
    <UpdateCard />
    <section>
      <h4 className="m-0 text-base font-semibold">{t("update.page.targets")}</h4>
      <p className="m-0 mt-1 text-sm text-muted [word-break:auto-phrase]">{t("update.page.targetsNote")}</p>
      {targets === null ? <RegionSkeleton shape="settingRows" rows={3} className="mt-3" /> : <ul className="m-0 mt-3 list-none border-t border-line p-0">
        {items.map(item => <li key={item.key} data-update-target={item.key} className="flex min-h-12 items-center gap-3 border-b border-line py-2">
          <span className="min-w-0 flex-1">
            <span className="block text-sm [word-break:auto-phrase]">{item.title}</span>
            {item.isSkill && <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5">
              {item.name && <code data-update-skill-name className="font-mono text-xs text-soft [overflow-wrap:anywhere]">{item.name}</code>}
              <span className="flex-none rounded-full border border-line px-1.5 text-xs text-muted">{t("update.page.skill")}</span>
            </span>}
          </span>
          <span className="w-28 flex-none text-end text-xs text-soft tabular-nums">
            {status.kind === "done" ? status.version : next ? <>{APP_VERSION}<TextMark className="mx-1"><Icon name="arrowRight" className="size-3" /></TextMark><span className="font-semibold text-ink">{next}</span></> : APP_VERSION}</span>
        </li>)}
      </ul>}
      <p className="m-0 mt-3 text-xs text-soft [word-break:auto-phrase]">{t("update.page.handEdits")}</p>
    </section>
  </div>;
}

/**
 * Where an update of this PC stands, as one card in every state: a mark of its tone (done, new, under way, needs the
 * person), a title saying the state, the versions from and to with the release notes, what to do or what happens next,
 * and its presses. Only the mark and the title take the warning colour; the words under them stay readable.
 */
type Card = { tone: "ok" | "new" | "busy" | "warn"; title: string; from: string | null; to: string; body?: string;
  action?: { label: string; run: () => void; secondary?: boolean }; pause?: string };
function useCard(status: UpdateStatus): Card {
  const { t } = useTranslation("panels");
  const held = useReloadHolds((state) => state.holds.size > 0);
  const now = APP_VERSION;
  switch (status.kind) {
    case "none": return { tone: "ok", title: t("update.card.latest"), from: null, to: now };
    case "withdrawn": return { tone: "ok", title: t("update.card.latest"), from: null, to: now, body: t("update.card.withdrawn", { version: status.version }) };
    case "available": {
      const later = status.requiresNoRuns && status.runs > 0;
      return later
        ? { tone: "new", title: t("update.card.afterRuns"), from: now, to: status.version, body: t("update.card.afterRunsBody", { count: status.runs }), pause: status.version }
        : { tone: "new", title: t("update.card.available"), from: now, to: status.version,
          body: status.note?.kind === "withdrawn" ? t("update.card.withdrawnBefore", { version: status.note.version }) : undefined,
          action: { label: t("update.start"), run: () => void pressUpdate(status) } };
    }
    case "fetching": return { tone: "busy", title: t("update.card.fetching"), from: now, to: status.version };
    case "waiting": return { tone: "busy", title: t("update.card.waiting"), from: now, to: status.version, body: t("update.card.waitingBody", { count: status.runs }),
      action: { label: t("update.postpone"), run: () => void postponeUpdate(status.opId), secondary: true } };
    case "applying": return { tone: "busy", title: t("update.card.applying"), from: now, to: status.version, body: t("update.card.applyingBody") };
    case "recovering": return { tone: "busy", title: t("update.card.recovering"), from: now, to: status.version, body: t("update.card.applyingBody") };
    case "failed": return { tone: "warn", from: now, to: status.version,
      title: status.runConflict ? t("update.card.runsActive") : t("update.card.failed"),
      body: status.runConflict ? t("update.card.runsActiveBody", { count: status.runConflict.runs })
        : t(`update.card.failedBody.${status.category}`),
      action: { label: t("update.retry"), run: () => void retryUpdate(status) }, pause: status.runConflict ? status.version : undefined };
    case "attention": return { tone: "warn", title: t("update.card.attention"), from: now, to: status.version ?? "", body: t("update.card.attentionBody"),
      action: { label: t("update.continue"), run: () => void continueUpdate(status) } };
    // The page loads the new version by itself; the card stays only while unsaved settings hold it, or a reload failed.
    case "done": return { tone: "ok", title: t("update.card.done"), from: null, to: status.version, body: held ? t("update.card.doneHeld") : t("update.card.doneBody"),
      action: { label: t("update.reload"), run: () => location.reload() } };
  }
}

const CARD_MARK: Record<Card["tone"], { icon: IconName; className: string }> = {
  ok: { icon: "check", className: "bg-[color:color-mix(in_oklab,var(--done)_14%,transparent)] text-done" },
  new: { icon: "arrowDown", className: "bg-[color:color-mix(in_oklab,var(--new)_14%,transparent)] text-new" },
  busy: { icon: "pending", className: "bg-[color:color-mix(in_oklab,var(--ink)_6%,transparent)] text-muted" },
  warn: { icon: "warn", className: "bg-[color:color-mix(in_oklab,var(--warn)_14%,transparent)] text-warn" },
};

/** `quiet`: nothing while there is nothing to do (the latest running), where the card stands beside other news. */
export function UpdateCard({ quiet = false }: { quiet?: boolean }) {
  const status = useUpdateStatus(), sending = useUpdateLocal((local) => local.sending);
  const card = useCard(status);
  if (quiet && !updateHasNews(status)) return null;
  const mark = CARD_MARK[card.tone];
  // One row carries the mark, the state with its versions, and the press, centred on each other: the mark on the two
  // lines boxed to their capitals and baseline, not on the card. What to do or what happens next reads under them.
  return <section data-update-card={status.kind} role="status" aria-live="polite"
    className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-4 rounded-lg border border-line px-5 py-4 [grid-template-areas:'mark_head_press'_'._body_body'_'._steps_steps'] narrow:grid-cols-1 narrow:[grid-template-areas:'head'_'body'_'steps'_'press']">
    {/* On a phone the mark stands in the title's line, so the words keep the card's width. */}
    <span className={cn("grid size-9 place-items-center rounded-full [grid-area:mark] narrow:hidden", mark.className)}>
      <Icon name={mark.icon} className={cn("size-4.5", card.tone === "busy" && "animate-spin [animation-duration:1.4s]")} strokeWidth={2.25} /></span>
    <div data-update-state className="contents">
      {/* Boxed to the title's capitals and the versions' baseline for the mark beside them; on a phone, where the mark
          stands in the title's line, the lines keep their whole height. */}
      <div className="cap-box [grid-area:head] narrow:[text-box:normal]"><h4 className={cn("m-0 text-base font-semibold [word-break:auto-phrase]", card.tone === "warn" && "text-warn")}>
        <TextMark className="me-2 hidden narrow:inline-grid"><span className={cn("grid size-6 place-items-center rounded-full", mark.className)}>
          <Icon name={mark.icon} className={cn("size-3.5", card.tone === "busy" && "animate-spin [animation-duration:1.4s]")} strokeWidth={2.5} /></span></TextMark>{card.title}</h4>
        {/* Running text, not a flex line, so the box above trims its last line and a wrapped line keeps its leading. */}
        <p className="m-0 mt-0.5 text-sm text-muted tabular-nums">
          <span className="me-2 whitespace-nowrap">alpacawork {card.from ? <>{card.from}<TextMark className="mx-1"><Icon name="arrowRight" className="size-3.5" /></TextMark><span className="font-semibold text-ink">{card.to}</span></> : card.to}</span>
          {card.to && <>{" "}<ReleaseNotes version={card.to} /></>}
        </p></div>
      {card.body && <p className="m-0 mt-3 text-sm text-muted [grid-area:body] [word-break:auto-phrase]">{card.body}</p>}
    </div>
    {/* Two presses (copy the pause, then retry) read as steps under the words that explain them. */}
    {card.pause && <div className="mt-3 flex flex-wrap items-center gap-2 [grid-area:steps] narrow:[&>*]:flex-1">
      <PauseInstruction version={card.pause} />{card.action && <CardPress card={card} sending={sending} />}</div>}
    {card.action && !card.pause && <div className="[grid-area:press] narrow:mt-4 narrow:[&>*]:w-full"><CardPress card={card} sending={sending} /></div>}
  </section>;
}

/** A card's press: the way forward in ink, a step aside (put off) outlined; held while its answer is awaited. */
function CardPress({ card, sending }: { card: Card; sending: boolean }) {
  const action = card.action!;
  return <Button data-update-action variant={action.secondary ? "outline" : "default"} className={cn("narrow:min-h-11", BUSY_PRESS)}
    aria-disabled={sending || undefined} onClick={() => { if (!sending) action.run(); }}>{action.label}</Button>;
}
