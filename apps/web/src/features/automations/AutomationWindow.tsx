import { automationEventSource } from "@alpacawork/contract/automation-program";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Message } from "@/components/ui/message";
import { Popup } from "@/components/ui/popup";
import { PendingRegion, ReadFailure } from "@/components/ui/loadable";
import { RegionSkeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { TAB, TAB_ROW, TabLabel, TabMarker } from "@/components/ui/tabs";
import { HEAD_MARK_GAP } from "@/components/ui/button";
import { notify } from "@/lib/notify";
import { appear } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { useWriteDisabled } from "@/data/queries";
import { formatLogTime } from "@/domain/time";
import { closeReaderStep } from "@/state/history-step";
import { readerOpenedByPress, useViewStore } from "@/state/view-store";
import { openSettings } from "@/state/dialog-store";
import { WindowWidthHandle } from "@/features/shell/docked-window";
import { readerBox, type ReaderMode } from "@/features/reader/Reader";
import { FrameButtons, HEAD_ROW, ListPager, readerHeadBox } from "@/features/reader/ReaderHeader";
import { keepFocusInside, StandingGrip, useSheetControl } from "@/features/reader/TaskSheet";
import { COLUMN } from "@/features/reader/reading-column";
import { MarkdownBody } from "@/features/reader/MarkdownBody";
import { attentionOf, useAutomationAct, useAutomationRuns, useShownAutomation, useVersionFiles } from "./data";
import { pointInputAt } from "./input-badge";
import { DeleteAutomationDialog } from "./DeleteAutomationDialog";
import { Sender } from "./SignalSender";
import { TryDialog } from "./TryDialog";
import { groupByDay } from "./AutomationsFace";
import { Fact, IntentLine, RunRow } from "./RunParts";
import type { AutomationPane } from "./place";
import type { Automation, Doc, Version } from "./shape";
import { aiCostText, aiText, dayCounts, knownWords, limitsText, outsideText, reasonText, reasonWords, whenNotes, whenText } from "./words";

/**
 * One automation, in the reader's window: the same frame a task stands in (its width and edge on a computer, a sheet
 * on a phone, ‹ › along the table, Expand, ×), over whatever face it was opened from, so the home stays under it. Its
 * head: its ID, its name, and what it does in one line (the first line of `run`'s JSDoc). Under them, a band when it
 * asks for something (a failure, a draft to read before turning on, a new version waiting), then its three panes:
 * what it does, its runs, its files. Turning it on and off, and trying it, stand at the panes' row.
 */
export function AutomationWindow({ id, mode, canDock }: { id: string; mode: ReaderMode; canDock: boolean }) {
  const { t } = useTranslation("automations");
  const pane = useViewStore(state => state.automation?.pane ?? "about");
  const { automation, read } = useShownAutomation(id);
  const sheet = useSheetControl();
  const box = useRef<HTMLElement>(null);
  // It comes in when a press opened it, as a task's window does; one a URL opened is simply there.
  useLayoutEffect(() => { if (readerOpenedByPress() && mode !== "sheet") appear(box.current, mode === "overlay" ? "below" : "side"); }, []);
  // The input talks about the automation open, on any face, until the window closes.
  const name = automation?.name ?? null;
  useEffect(() => { pointInputAt({ id, name }); }, [id, name]);
  useEffect(() => () => pointInputAt(null), []);
  return <aside ref={box} aria-label={t("window.label", { id })} data-reader-mode={mode} data-window="" data-automation-window={id}
    onKeyDown={mode === "overlay" || sheet?.whole ? keepFocusInside : undefined} className={readerBox(mode)}>
    {canDock && <WindowWidthHandle label={t("window.resize")} />}
    <StandingGrip />
    <header {...sheet?.grip} className={`${readerHeadBox(mode)} @container/reader border-transparent`}>
      <div className={`-mr-3 flex min-w-0 items-center overflow-x-clip pr-3 text-xs text-muted ${HEAD_MARK_GAP}`}>
        <span data-automation-id className={`flex min-w-0 flex-1 items-center font-medium text-ink tabular-nums ${HEAD_ROW}`}>{id}</span>
        <span className={`flex flex-none items-center ${HEAD_ROW}`}><ListPager id={id} /></span>
        <FrameButtons canDock={canDock} />
      </div>
    </header>
    <div data-automation-content className="min-h-0 flex-1 overflow-auto px-4 pt-1 pb-(--list-foot) [overflow-wrap:anywhere] narrow:px-3">
      <div className={COLUMN.body}>
        {automation ? <Opened automation={automation} pane={pane} />
          : read.error ? <ReadFailure what={t("window.failed", { id })} error={read.error} retry={() => read.refetch()} />
          : <RegionSkeleton shape="reports" />}
      </div>
    </div>
  </aside>;
}

function Opened({ automation, pane }: { automation: Automation; pane: AutomationPane }) {
  const { t } = useTranslation("automations");
  const [trying, setTrying] = useState(false);
  // Every way of turning it on (the switch, a band's button) whose version's AI review the person has not read yet
  // shows what the review said first, in the band, and turns on from there.
  const [reading, setReading] = useState(false);
  const shown = automation.live ?? automation.latest;
  // Opened by a press, the focus goes to its title, as a task's window takes it (Escape closes it: use-shortcuts).
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => { if (readerOpenedByPress()) title.current?.focus({ preventScroll: true }); }, [automation.id]);
  const read = () => setReading(true);
  return <>
    <div {...useSheetControl()?.grip}>
      <h2 ref={title} tabIndex={-1} data-automation-title dir="auto" className="m-0 mb-1 text-xl text-ink outline-none narrow:text-lg">{automation.name}</h2>
      <p data-automation-summary dir="auto" className="m-0 mb-3 text-sm text-muted">{shown.docs.run.summary}</p>
    </div>
    <Band automation={automation} reading={reading} onRead={read} onBack={() => setReading(false)} />
    <div className="sticky top-0 z-1 -mx-1 mb-2 flex items-center gap-2 border-b border-rule bg-lit px-1 py-1.5 narrow:flex-wrap">
      <PaneTabs pane={pane} />
      <span className="ms-auto flex flex-none items-center gap-2">
        <OnSwitch automation={automation} onRead={read} />
        <Button variant="outline" data-automation-try className="narrow:min-h-11" onClick={() => setTrying(true)}>{t("try.open")}</Button>
        <MoreMenu automation={automation} />
      </span>
    </div>
    {pane === "log" ? <LogPane automation={automation} /> : pane === "code" ? <CodePane automation={automation} /> : <AboutPane automation={automation} />}
    {trying && <TryDialog automation={automation} onClose={() => setTrying(false)} />}
  </>;
}

function PaneTabs({ pane }: { pane: AutomationPane }) {
  const { t } = useTranslation("automations");
  const setPane = useViewStore(state => state.setAutomationPane);
  return <div role="group" aria-label={t("window.panes")} className={TAB_ROW}>
    <TabMarker current='[aria-current="page"]' />
    {(["about", "log", "code"] as const).map(each => <button key={each} type="button" data-automation-pane={each} aria-current={pane === each ? "page" : undefined}
      onClick={() => setPane(each)} className={cn(TAB, "aria-[current=page]:font-semibold aria-[current=page]:text-ink narrow:min-h-11")}>
      <TabLabel>{t(`pane.${each}`)}</TabLabel></button>)}
  </div>;
}

/** Whether a version's AI's look found something the person has not said they read. */
const reviewToRead = (version: Version) => version.review.state !== "ok" && !version.review.acknowledged;

/**
 * On and off, beside its word. A draft (never on) has no switch: it is turned on from the band that says what to read
 * first. Turning on an off one whose AI's look found something opens that band instead of turning it on.
 */
function OnSwitch({ automation, onRead }: { automation: Automation; onRead: () => void }) {
  const { t } = useTranslation("automations");
  const act = useAutomationAct();
  const writeDisabled = useWriteDisabled();
  if (!automation.everEnabled && !automation.enabled) return <span data-automation-mark="draft" className="rounded-xs border border-line px-1.5 text-xs text-muted">{t("mark.draft")}</span>;
  return <label className="flex items-center gap-1.5 text-sm text-muted">
    <Switch data-automation-switch checked={automation.enabled} disabled={writeDisabled || act.isPending} aria-label={t("toggle", { name: automation.name })}
      onCheckedChange={on => {
        if (on && reviewToRead(automation.latest)) { onRead(); return; }
        act.mutate({ act: on ? "enable" : "disable", automation });
      }} />
    {t(automation.enabled ? "on" : "off")}
  </label>;
}

/** Deleting, from the "more" menu, asked once in a dialog of its own. */
function MoreMenu({ automation }: { automation: Automation }) {
  const { t } = useTranslation("automations");
  const [open, setOpen] = useState(false);
  const [asking, setAsking] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const remove = useAutomationAct({ errorToast: false });
  const writeDisabled = useWriteDisabled();
  const confirm = () => remove.mutate({ act: "delete", automation }, { onSuccess: () => {
    setAsking(false);
    notify.success(t("deleted", { id: automation.id }));
    closeReaderStep();
  } });
  return <>
    <Button ref={trigger} variant="ghost" size="icon" data-automation-more aria-label={t("more")} title={t("more")} aria-haspopup="menu"
      aria-expanded={open} disabled={writeDisabled} className="narrow:size-11" onClick={() => setOpen(!open)}><Icon name="more" /></Button>
    {open && <Popup open onOpenChange={setOpen} label={t("more")} align="end" className="w-56 p-1" anchorRef={trigger}>
      <div role="menu" aria-label={t("more")} className="flex flex-col">
        <Button variant="ghost" role="menuitem" data-automation-delete className="h-9 w-full justify-start px-2.5 font-normal text-warn"
          onClick={() => { setOpen(false); remove.reset(); setAsking(true); }}>{t("delete")}</Button>
      </div>
    </Popup>}
    {asking && <DeleteAutomationDialog automation={automation} onOpenChange={setAsking} onDelete={confirm} pending={remove.isPending} failure={remove.error} />}
  </>;
}

/**
 * What asks for something, one band at most, above the panes so every pane shows it: a failure (or going off by
 * itself) with why and what to do; a new version waiting to be turned on, beside the one running; a draft, with what to
 * read before turning it on. Its main act stands at the right of its heading, in view where the window opens.
 */
function Band({ automation, reading, onRead, onBack }: { automation: Automation; reading: boolean; onRead: () => void; onBack: () => void }) {
  const attention = attentionOf(automation);
  // Asked to turn on a version whose review is unread: what it said comes first, wherever the asking came from.
  if (reading && reviewToRead(automation.latest)) return <BeforeOnBand automation={automation} onBack={onBack} />;
  if (attention && (attention.kind === "failed" || attention.kind === "disabled")) return <FailedBand automation={automation} failure={attention} onRead={onRead} />;
  if (automation.awaitingEnable) return <AwaitingBand automation={automation} onRead={onRead} />;
  if (!automation.enabled && !automation.everEnabled) return <BeforeOnBand automation={automation} />;
  return null;
}

/** A band's buttons: a finger's 44px on a phone. */
const BAND_BUTTON = "narrow:min-h-11";

function BandFrame({ title, action, children, failed, ...data }: { title: ReactNode; action?: ReactNode; children: ReactNode; failed?: boolean; [data: `data-${string}`]: unknown }) {
  return <section {...data} className="mb-4 rounded-lg border border-line bg-raised p-3 narrow:p-2.5">
    <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
      <h3 className={cn("m-0 text-sm font-semibold", failed ? "text-error" : "text-ink")}>{title}</h3>
      {action}
    </div>
    {children}
  </section>;
}

/**
 * A failure: when, why in words (of the run that failed, whatever ran after it), and the one thing that sets it right:
 * turning it on again (after reading its review when that is unread), the AI's settings, or its runs to read why.
 */
function FailedBand({ automation, failure, onRead }: { automation: Automation; failure: Automation["attention"][number]; onRead: () => void }) {
  const { t, i18n } = useTranslation("automations");
  const act = useAutomationAct();
  const writeDisabled = useWriteDisabled();
  const setPane = useViewStore(state => state.setAutomationPane);
  const off = !automation.enabled;
  const why = off && automation.disabledReason && knownWords(t, `reason.${automation.disabledReason}`) || reasonText(t, failure);
  const action = off ? <Button data-automation-band-act className={BAND_BUTTON} disabled={writeDisabled || act.isPending}
      onClick={() => reviewToRead(automation.latest) ? onRead() : act.mutate({ act: "enable", automation })}>{t("band.turnOn")}</Button>
    : failure.reasonKind === "ai_unavailable" || failure.reasonKind === "unavailable" ? <Button variant="outline" data-automation-band-act className={BAND_BUTTON} onClick={() => openSettings("ai")}>{t("band.openAi")}</Button>
    : <Button variant="outline" data-automation-band-act className={BAND_BUTTON} onClick={() => setPane("log")}>{t("band.readRuns")}</Button>;
  return <BandFrame data-automation-band="failed" failed title={t(off ? "band.offTitle" : "band.failedTitle", { time: formatLogTime(failure.at, i18n.language) })} action={action}>
    <p className="m-0 text-sm">{why}{!off && <>{why && t("sentence")}{t("band.failedNext")}</>}</p>
  </BandFrame>;
}

/**
 * Its words changed by a new version while the one before keeps running: who made the new one and from what words, the
 * two versions' first lines side by side with what differs marked, and turning the new one on, reading the difference
 * in the files, or dropping it.
 */
function AwaitingBand({ automation, onRead }: { automation: Automation; onRead: () => void }) {
  const { t, i18n } = useTranslation("automations");
  const act = useAutomationAct();
  const writeDisabled = useWriteDisabled();
  const setPane = useViewStore(state => state.setAutomationPane);
  const latest = automation.latest, live = automation.live!;
  const [before, after] = differing(live.docs.run.summary, latest.docs.run.summary);
  const enable = () => reviewToRead(latest) ? onRead() : act.mutate({ act: "enable", automation });
  return <BandFrame data-automation-band="awaiting" title={t("band.awaitingTitle")}
    action={<Button data-automation-band-act className={BAND_BUTTON} disabled={writeDisabled || act.isPending} onClick={enable}>{t("band.awaitingOn")}</Button>}>
    <p className="m-0 line-clamp-3 text-sm text-muted">{madeBy(t, latest, i18n.language)}{t("sentence")}</p>
    <p className="m-0 mb-2 text-sm text-muted">{t("band.awaitingKeeps")}</p>
    <div className="mb-2 grid grid-cols-2 gap-2 narrow:grid-cols-1">
      <VersionCard head={t("band.running", { digest: short(live.digest) })} words={before} />
      <VersionCard head={[t("band.newVersion", { digest: short(latest.digest), time: formatLogTime(latest.savedAt, i18n.language) }), reviewLine(t, latest)].join(t("join"))} words={after} />
    </div>
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="outline" data-automation-diff className={BAND_BUTTON} onClick={() => setPane("code")}>{t("band.diff")}</Button>
      <Button variant="ghost" data-automation-discard className={BAND_BUTTON} disabled={writeDisabled || act.isPending} onClick={() => act.mutate({ act: "discard", automation })}>{t("band.discard")}</Button>
    </div>
  </BandFrame>;
}

function VersionCard({ head, words }: { head: string; words: ReactNode }) {
  return <div className="rounded-md border border-line p-2.5 text-sm">
    <p className="m-0 mb-1 text-xs text-muted">{head}</p>
    <p dir="auto" className="m-0">{words}</p>
  </div>;
}

/** Two sentences with what differs between them marked: the part between what they begin and end with alike. */
function differing(a: string, b: string): [ReactNode, ReactNode] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  const mark = (text: string) => {
    const middle = text.slice(start, text.length - end);
    return middle ? <>{text.slice(0, start)}<mark data-automation-differs className="rounded-xs bg-hover px-0.5 text-ink">{middle}</mark>{text.slice(text.length - end)}</> : text;
  };
  return [mark(a), mark(b)];
}

const short = (digest: string) => digest.replace(/^sha256:/, "").slice(0, 7);

/** Who saved a version and when: "11/27 16:10, made by the coordinator when you asked 'only from 3 on'". */
function madeBy(t: ReturnType<typeof useTranslation<"automations">>["t"], version: Version, locale: string): string {
  const time = formatLogTime(version.savedAt, locale);
  // The coordinator's save names the person's words only when the server kept them.
  if (version.savedBy.kind === "coordinator") return version.savedBy.request ? t("band.madeByAsk", { time, words: version.savedBy.request }) : t("band.madeByCoordinator", { time });
  return version.savedBy.kind === "person" ? t("band.madeByPerson", { time }) : t("band.madeByAgent", { time });
}

/** The AI's look at a version, in a few words: nothing found, what it found, it could not look. */
function reviewLine(t: ReturnType<typeof useTranslation<"automations">>["t"], version: Version): string {
  const review = version.review;
  if (review.state === "running") return t("review.running");
  if (review.state === "unavailable") return t("review.unavailable");
  return review.findings.length ? t("review.found", { count: review.findings.length }) : t("review.ok");
}

/**
 * A draft, before it is first turned on: what the AI's look found (or that it could not look), what it does directly
 * and not through alpacawork (which cannot be stopped), and what it would do, from its last showing. Turning it on
 * stands at the heading: "Turn on, having read this" when there is something to read.
 */
function BeforeOnBand({ automation, onBack }: { automation: Automation; onBack?: () => void }) {
  const asked = !!onBack;
  const { t, i18n } = useTranslation("automations");
  // Asked for from further down (the switch), it is brought into view: the press is answered where it is seen.
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { if (asked) box.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }); }, [asked]);
  const act = useAutomationAct();
  const writeDisabled = useWriteDisabled();
  const latest = automation.latest, review = latest.review;
  const toRead = reviewToRead(latest);
  const intents = latest.preview?.operations.filter(operation => operation.replaced) ?? [];
  return <div ref={box}><BandFrame data-automation-band="before-on" title={t(automation.awaitingEnable ? "band.beforeNewTitle" : "band.beforeTitle")}
    action={onBack ? <Button variant="outline" data-automation-band-back className={BAND_BUTTON} onClick={onBack}>{t("band.back")}</Button> : <Button data-automation-band-act className={BAND_BUTTON} disabled={writeDisabled || act.isPending || review.state === "running"}
      onClick={() => act.mutate({ act: "enable", automation, acknowledge: toRead })}>{t(toRead ? "band.acknowledgeOn" : "band.turnOn")}</Button>}>
    <dl className="m-0 grid grid-cols-[8rem_minmax(0,1fr)] gap-x-4 gap-y-2.5 text-sm narrow:grid-cols-1 narrow:gap-y-0.5">
      <Fact name={t("band.review")}>
        {review.state === "running" ? t("review.running") : review.state === "unavailable" ? t("review.unavailable")
          : review.findings.length ? review.findings.map((finding, at) => <p key={at} className="m-0">{t(finding.level === "must" ? "review.must" : "review.note", { text: finding.text })}</p>)
          : t("review.ok")}
        {review.model && review.at && <span className="block text-xs text-muted">{review.model}{t("join")}{formatLogTime(review.at, i18n.language)}</span>}
      </Fact>
      {latest.direct && <Fact name={t("band.direct")}>
        {/* None found is only none when the review looked: without it, only the parts the program uses were read. */}
        {latest.direct.length ? latest.direct.map((effect, at) => <p key={at} className="m-0">{t(`effect.${effect.kind}`)}{t("colon")}{effect.text}</p>) : review.state === "ok" || review.state === "fix" ? t("band.directNotFound") : t("band.directUnknown")}
        {latest.direct.length > 0 && <span className="block text-xs text-muted">{t("band.directNote")}</span>}
      </Fact>}
      <Fact name={t("band.intent")}>
        {latest.preview?.ran ? intents.length ? intents.map((operation, at) => <IntentLine key={at} operation={operation} automation={automation} />) : t("band.intentNothing")
          : t("band.intentNotShown")}
        {latest.preview?.ran && <span className="block text-xs text-muted">{t("band.intentFrom", { time: formatLogTime(latest.preview.at, i18n.language) })}</span>}
      </Fact>
    </dl>
    {onBack && <div className="mt-3 flex"><Button data-automation-band-act className={BAND_BUTTON} disabled={writeDisabled || act.isPending || review.state === "running"}
      onClick={() => act.mutate({ act: "enable", automation, acknowledge: toRead })}>{t(toRead ? "band.acknowledgeOn" : "band.turnOn")}</Button></div>}
  </BandFrame></div>;
}

/**
 * What it does: when it runs and its limits (the facts the server took from `config`), then what each function does in
 * the AI's own words (its JSDoc), then the last 7 days in one line. The version running is described while one runs.
 */
function AboutPane({ automation }: { automation: Automation }) {
  const { t } = useTranslation("automations");
  const version = automation.live ?? automation.latest;
  const facts = version.facts;
  const [senders, setSenders] = useState(false);
  const notes = whenNotes(t, facts.when, automation.hook.exists);
  const week = automation.week;
  const busiest = week?.busiestDay ?? null;
  return <div data-automation-about>
    <Section title={t("about.facts")}>
      <Row name={t("about.when")}>
        <p className="m-0">{whenText(t, facts.when, facts.limits.timezone)}{facts.when.filter && <> — {facts.when.filter}</>}</p>
        {notes.length > 0 && <p className="m-0 text-xs text-muted">
          {automationEventSource(facts.when.event) === "signal" ? <Button variant="ref" data-automation-senders aria-expanded={senders} className="text-xs" onClick={() => setSenders(!senders)}>{notes.join(t("join"))}</Button>
            : notes.join(t("join"))}</p>}
        {senders && <div className="mt-2"><Sender automation={automation} /></div>}
      </Row>
      <Row name={t("about.limits")}>
        <p className="m-0">{limitsText(t, facts.limits, facts.when.event)}</p>
        {busiest !== null && busiest > 0 && <p className="m-0 flex items-center gap-2 text-xs text-muted">
          <span aria-hidden className="h-1 w-24 overflow-hidden rounded-full bg-hover"><span className="block h-full bg-ink" style={{ width: `${Math.min(100, Math.round(busiest / facts.limits.perDay * 100))}%` }} /></span>
          {t("about.busiest", { count: busiest })}</p>}
      </Row>
      <Row name={t("about.ai")}>
        <p className="m-0">{aiText(t, facts)}</p>
        {aiCostText(t, facts) && <p className="m-0 text-xs text-muted">{aiCostText(t, facts)}</p>}
      </Row>
      <Row name={t("about.outside")}><p className="m-0">{outsideText(t, facts)}</p></Row>
    </Section>
    <Section title={t("about.program")}>
      {version.docs.trigger && <DocRow name={t("about.trigger")} fn="trigger" doc={version.docs.trigger} />}
      <DocRow name={t("about.run")} fn="run" doc={version.docs.run} />
    </Section>
    {week && <Section title={t("about.week")}>
      <p data-automation-week-line className="m-0 py-1 text-sm">{!week.matched ? t("about.weekNone") : <>
        {t("about.weekLine", { matched: week.matched, started: week.started, skipped: week.skipped })}
        {week.skippedBy.length > 0 && t("about.weekWhy", { list: week.skippedBy.map(item => `${skipName(t, item.reason)} ${item.count}`).join(t("join")) })}
        {week.failed > 0 && <>{t("join")}{t("about.weekFailed", { count: week.failed })}</>}</>}</p>
    </Section>}
  </div>;
}

/** Why runs were skipped, by kind: `trigger` said no, or a limit's words. */
function skipName(t: ReturnType<typeof useTranslation<"automations">>["t"], reason: string): string {
  if (reason === "trigger" || reason === "trigger_rejected") return t("about.skipTrigger");
  return reasonWords(t, reason) ?? reason;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <section className="mb-5">
    <h3 className="m-0 border-b border-rule pb-2 text-sm font-semibold">{title}</h3>
    {children}
  </section>;
}

/** A fact: its name on the left (above it on a phone), its line and a small line under it. */
function Row({ name, children }: { name: string; children: ReactNode }) {
  return <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-4 border-b border-rule py-2.5 text-sm narrow:grid-cols-1 narrow:gap-y-0.5">
    <span className="text-muted">{name}</span><div className="min-w-0">{children}</div>
  </div>;
}

/**
 * A function in its AI's own words: what it is for and its name in code, its first line and its body, what it takes
 * and what it returns.
 */
function DocRow({ name, fn, doc }: { name: string; fn: string; doc: Doc }) {
  const { t } = useTranslation("automations");
  const takes = doc.params.map(param => param.text).join(t("join"));
  return <div data-automation-doc={fn} className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-4 border-b border-rule py-2.5 text-sm narrow:grid-cols-1 narrow:gap-y-0.5">
    <span className="text-muted">{name}<span className="block font-mono text-xs">{fn}</span></span>
    <div className="min-w-0">
      <p dir="auto" className="m-0">{doc.summary}</p>
      {doc.body && <div className="text-sm text-muted"><MarkdownBody text={doc.body} task={null} onFollow={() => {}} /></div>}
      {(takes || doc.returns) && <p className="m-0 mt-1 text-xs text-muted">
        {takes && <><b className="font-semibold text-ink">{t("about.takes")}</b> {takes}</>}
        {takes && doc.returns && t("join")}
        {doc.returns && <><b className="font-semibold text-ink">{t("about.returns")}</b> {doc.returns}</>}</p>}
      {doc.throws.length > 0 && <p className="m-0 text-xs text-muted"><b className="font-semibold text-ink">{t("about.throws")}</b> {doc.throws.join(t("join"))}</p>}
    </div>
  </div>;
}

/** Its runs, a line each, newest first under each day's counts; a signal still waiting to run first. */
function LogPane({ automation }: { automation: Automation }) {
  const { t, i18n } = useTranslation("automations");
  const runs = useAutomationRuns(automation.id);
  const facts = (automation.live ?? automation.latest).facts;
  return <div data-automation-runs>
    {automation.pendingSignal && <p data-automation-pending className="m-0 mb-2 text-sm text-muted">{t("runs.pending", { count: automation.pendingSignal.count })}</p>}
    {runs.error && !runs.data ? <ReadFailure what={t("runs.failed")} error={runs.error} retry={() => runs.refetch()} />
      : !runs.data ? <PendingRegion pending shape="reports" />
      : !runs.data.length ? <Message tone="empty" size="line" title={t(automation.enabled ? "runs.emptyOn" : "runs.emptyOff")} />
      : groupByDay(runs.data, i18n.language).map(day => {
        const counts = dayCounts(day.runs);
        return <section key={day.day}>
          <h4 className="m-0 flex items-baseline gap-3 border-b border-rule py-2 text-sm font-semibold">{day.day}
            <span className="font-normal text-muted">{[t("runs.matched", { count: counts.matched }), t("runs.ran", { count: counts.ran }), t("runs.skipped", { count: counts.skipped })].join(t("join"))}</span></h4>
          <ul className="m-0 list-none p-0">{day.runs.map(run => <RunRow key={run.number} automation={automation.id} run={run} facts={facts} />)}</ul>
        </section>;
      })}
  </div>;
}

/**
 * Its files: the version running (and the new one waiting), what the AI's look said of it, its time limit, then each
 * file, the one chosen shown (the entry first).
 */
function CodePane({ automation }: { automation: Automation }) {
  const { t, i18n } = useTranslation("automations");
  const latest = automation.latest, live = automation.live;
  const [version, setVersion] = useState<"latest" | "live">("latest");
  const shown = version === "live" && live ? live : latest;
  const [file, setFile] = useState("main.ts");
  const files = useVersionFiles(automation.id, shown.digest, true);
  const text = files.data?.find(each => each.path === file)?.text ?? files.data?.[0]?.text;
  const versionLine = (each: Version) => <>
    <p className="m-0"><span className="font-mono text-xs">{short(each.digest)}</span>{t("join")}{formatLogTime(each.savedAt, i18n.language)}</p>
    <p className="m-0 text-xs text-muted">{t("code.review", { text: reviewLine(t, each) })}</p></>;
  return <div data-automation-code>
    <Section title={t("code.versions")}>
      {live && <Row name={t("code.live")}>{versionLine(live)}</Row>}
      {(!live || automation.awaitingEnable) && <Row name={t(live ? "code.new" : "code.latest")}>{versionLine(latest)}</Row>}
      <Row name={t("code.timeout")}><p className="m-0">{t("code.timeoutValue", { count: latest.facts.limits.timeoutMinutes })}</p></Row>
    </Section>
    <Section title={t("code.files")}>
      {live && automation.awaitingEnable && <div role="group" className="flex gap-2 py-2 text-sm">
        {(["latest", "live"] as const).map(each => <Button key={each} variant={version === each ? "outline" : "ghost"} aria-pressed={version === each}
          onClick={() => setVersion(each)}>{t(each === "latest" ? "code.showNew" : "code.showLive")}</Button>)}</div>}
      <ul className="m-0 list-none p-0">{shown.files.map(each => <li key={each.path} className="border-b border-rule">
        <button type="button" data-automation-file={each.path} aria-pressed={each.path === file} onClick={() => setFile(each.path)}
          className="flex w-full items-baseline gap-2 py-2 text-start font-mono text-xs hover:bg-row-hover aria-pressed:font-semibold narrow:min-h-11">
          {each.path}{each.path === "main.ts" && <span className="font-sans text-muted">{t("code.entry")}</span>}</button></li>)}</ul>
      {files.error ? <ReadFailure what={t("code.failed")} error={files.error} retry={() => files.refetch()} />
        : !files.data ? <PendingRegion pending shape="rows" />
        : <pre data-automation-source className="m-0 mt-2 max-h-[60vh] overflow-auto rounded-md bg-hover p-3 font-mono text-xs whitespace-pre-wrap">{text}</pre>}
    </Section>
  </div>;
}
