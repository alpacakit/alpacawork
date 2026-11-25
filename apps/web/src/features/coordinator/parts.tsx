import { useTranslation } from "react-i18next";
import { i18n } from "@alpacawork/i18n";
import type { CoordinatorTurn } from "@/data/coordinator";
import { useEveryTaskIndex } from "@/data/queries";
import { resolveReference } from "@/domain/tasks";
import { taskTokens } from "./editor/wire";
import { memo, useContext, useEffect, useLayoutEffect, useReducer, useRef, useState, useSyncExternalStore, type RefObject } from 'react';
import { WorkspaceContext } from '@/data/workspace-store';
import { useConversation } from './coordinator';
import { paceKey, workPacer, type Pace } from './work-pace';
import { workNameWords } from '@/domain/work-words';
import { causeReason, limitName } from '@/domain/run-labels';
import { agentLabel } from '@/domain/agent-label';
import { StepList, WorkLine, stepCount, useRunSteps } from '@/features/people/RunSteps';
import { tookSteps } from '@alpacawork/contract/run';
import { Icon } from '@/components/ui/icon';
import { MarkdownBody } from '@/features/reader/MarkdownBody';
import { followTask } from './follow-task';
import { scrollThreadTo } from './thread-position';
import { cn } from '@/lib/utils';
import { useConnection } from '@/data/connection';

/**
 * The words of a running turn: its recent work's name while the pacer shows it for this turn, else the turn's own, then
 * the whole seconds since the message was sent (`at`, kept with the message, so neither the work nor a remount, reload
 * or reconnect restarts them). With no running turn given, the turn's own words alone.
 */
export function useWorkingWords(turn?: { id: string; at: string }): string {
  const { t } = useTranslation('ui');
  const store = useContext(WorkspaceContext);
  const pacer = store ? workPacer(store) : idle;
  const pace = useSyncExternalStore(pacer.subscribe, pacer.snapshot);
  const conversation = useConversation(state => state.conversation?.id);
  // The hold starts when the words reach the DOM, not when a value arrives or a timer fires.
  useLayoutEffect(() => pacer.committed(pace.version), [pacer, pace.version]);
  const words = pace.label && conversation && turn && pace.key === paceKey(conversation, turn.id)
    ? workNameWords(pace.label) : t('coordinatorCard.thinking');
  return useWorkingFor(turn?.at, words);
}
/** `words` with the whole seconds since `at` after them, drawn again each second; `words` alone without `at`. */
function useWorkingFor(at: string | undefined, words: string): string {
  const { t } = useTranslation('ui');
  const seconds = useSecondsSince(at);
  return seconds === null ? words : t('coordinatorCard.working', { words, seconds });
}
/** Whole seconds since `at`, drawn again on each whole second after it; null without `at`. */
function useSecondsSince(at: string | undefined): number | null {
  const start = at === undefined ? Number.NaN : Date.parse(at);
  const [, tick] = useReducer((count: number) => count + 1, 0);
  useEffect(() => {
    if (Number.isNaN(start)) return;
    let timer: ReturnType<typeof setTimeout>;
    const next = () => { timer = setTimeout(() => { tick(); next(); }, 1000 - (((Date.now() - start) % 1000) + 1000) % 1000); };
    next();
    return () => clearTimeout(timer);
  }, [start]);
  return Number.isNaN(start) ? null : Math.max(0, Math.floor((Date.now() - start) / 1000));
}
/** The seconds a turn has been at work, on their own: their tick draws them alone, not the work line they end. */
const WorkSeconds = memo(function WorkSeconds({ at }: { at: string }) {
  const seconds = useSecondsSince(at);
  return seconds === null ? null : <span data-work-seconds className="flex-none text-muted tabular-nums">{seconds}s</span>;
});
const none: Pace = { key: null, label: null, version: 0 };
/** Before the first index there is no workspace and nothing to pace. */
const idle = { subscribe: () => () => {}, snapshot: () => none, committed: (_version: number) => {} };
const noStore = () => () => {};

/** A mark while waiting for an answer: a quiet pulse of opacity alone. */
function Pulse({ children }: { children: string }) {
  return <span data-ask-thinking className="text-muted tabular-nums motion-safe:animate-pulse">{children}</span>;
}
/** The running turn on one line where the work is not shown: its recent work's rounded name and the seconds (useWorkingWords). */
export function Thinking({ turn }: { turn: { id: string; at: string } }) {
  return <Pulse>{useWorkingWords(turn)}</Pulse>;
}

/* Hallmark · component: the running turn's reply in the open conversation · genre: modern-minimal · theme: the app's own
 * tokens · states: nothing run yet (the mark, "Working on it…", the seconds) · a step (the mark, the step, the seconds, ⌄) ·
 * open (the line counts the steps, every step so far under it, ⌃) */
/**
 * What the running turn is doing, where the conversation is open: its latest words, then one line that says it all —
 * the moving mark, the latest step (or that it works, before any), and the seconds since the message. A press on the
 * line opens every step so far under it, oldest first, as History's working row does; another folds them.
 */
export function WorkingReply({ turn }: { turn: { id: string; at: string } }) {
  const { t } = useTranslation('ui'), { t: p } = useTranslation('people');
  const store = useContext(WorkspaceContext);
  const work = useSyncExternalStore(store?.subscribe ?? noStore, () => store?.getState().info.coordinatorWork ?? null);
  const conversation = useConversation(state => state.conversation?.id);
  const [open, setOpen] = useState(false);
  // Offline, the last work received says nothing of now: as the folded words drop it (work-pace), so do these.
  const offline = useConnection(state => state.offline);
  // The turn's work, as last received for it: the Run's work ends a moment before the turn's answer comes, and until the
  // answer takes its place the turn keeps saying what it did, so nothing under it is taken away and put back.
  const live = work && work.conversation === conversation && work.turn === turn.id ? work : null;
  const last = useRef(live);
  if (live) last.current = live;
  const kept = last.current && last.current.conversation === conversation ? last.current : null;
  const mine = offline ? null : live ?? kept;
  const step = mine?.steps.at(-1);
  // Brought up to date whenever any of its steps starts or ends, however many run at once.
  // Whether there is a list is whether the Run has taken any step (tookSteps), as everywhere its steps are offered.
  const worked = tookSteps(mine);
  const steps = useRunSteps(mine?.run, open && worked, mine?.stepEvents ?? 0);
  const block = useRef<HTMLDivElement>(null);
  useListedInSight(steps.listed, block);
  const time = <WorkSeconds at={turn.at} />;
  const count = stepCount(steps);
  return <div>
    {mine?.words && <div data-working-words dir="auto" className="mb-2 [overflow-wrap:anywhere]"><MarkdownBody text={mine.words} task={null} variant="note" onFollow={followTask} /></div>}
    {/* The work line beside the message, at the size of its other states and the answer's own line. */}
    <div ref={block} className="scroll-mt-[max(3rem,calc(var(--pane-head,1.25rem)+1rem))] text-xs">
    {worked ? <button type="button" data-working-steps aria-expanded={open} onClick={() => setOpen(!open)} className={STEPS_BUTTON}>
      <WorkLine data-ask-thinking step={step} idle={t('coordinatorCard.thinking')} label={count === undefined ? undefined : p('now.step.count', { count })} className="min-w-0 flex-1 group-hover/steps:text-ink"
        end={<>{time}<Chevron open={open} /></>} /></button>
      : <WorkLine data-ask-thinking step={undefined} idle={t('coordinatorCard.thinking')} end={time} />}
    {open && worked && <StepList steps={steps} className={CHAT_LOG} />}
  </div></div>;
}
/**
 * A line that opens a Run's steps under it: its whole width a press, a finger's height on a phone. The press overhangs
 * the line evenly, so its words stand where the line's words stand before it can be pressed (and where any other state
 * of a message is said).
 */
const STEPS_BUTTON = "group/steps flex w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-sm -my-1 py-1 text-left outline-none focus-visible:outline-2 focus-visible:outline-ring narrow:min-h-11 narrow:-my-[calc((--spacing(11)-1lh)/2)]";
/** The conversation is short: its steps' box keeps the answer under it in sight, a step opened in it too. */
const CHAT_LOG = "mt-1 max-h-[min(14rem,35vh)] narrow:max-h-[min(16rem,40vh)] has-[[data-run-step-open]]:max-h-[min(14rem,35vh)] narrow:has-[[data-run-step-open]]:max-h-[min(16rem,40vh)]";
function Chevron({ open }: { open: boolean }) {
  return <Icon name="down" className={cn("size-3.5 flex-none self-center text-muted transition-transform duration-(--motion-base) group-hover/steps:text-ink", open && "rotate-180")} />;
}
/**
 * The steps are read after the press: once first drawn, the line and the list under it come into sight as one place
 * request, the list's head (the line, then "earlier") first. One that does not fit below where it is starts at the top.
 */
function useListedInSight(read: unknown, block: RefObject<HTMLElement | null>, top = false) {
  const listed = useRef(false);
  useLayoutEffect(() => {
    if (!read) { listed.current = false; return; }
    const element = block.current;
    if (listed.current || !element) return;
    listed.current = true;
    const area = element.closest<HTMLElement>('[data-card-scroll]')?.getBoundingClientRect() ?? { top: 0, bottom: window.innerHeight };
    const box = element.getBoundingClientRect();
    if (box.top < area.top || box.height > area.bottom - area.top || (top && box.bottom > area.bottom)) scrollThreadTo(element, element, { block: 'start' });
    else if (box.bottom > area.bottom) scrollThreadTo(element, element, { block: 'end' });
  }, [read, block, top]);
}

/* Hallmark · component: an answered message's steps · genre: modern-minimal · theme: the app's own tokens · states:
 * folded (a small pill: the work's mark, its words and ⌄ side by side) · open (the pill counts the steps and turns ⌃, the
 * steps' box under it, then the answer) · reading · not readable */
/**
 * The steps of the Run that answered, above its answer where the work line stood while it ran: one small pill, as
 * wide as its words, that opens them under it and closes them again, read only once opened. Its mark, words and
 * arrow are one press, so it reads as the answer's own way into its work.
 */
export function AnswerSteps({ run }: { run: string }) {
  const { t } = useTranslation('people');
  const [open, setOpen] = useState(false);
  const steps = useRunSteps(run, open);
  const block = useRef<HTMLDivElement>(null);
  // Opened, the pill goes to the top where it must move, so the answer's start stays in sight under the steps.
  useListedInSight(steps.listed, block, true);
  const count = stepCount(steps);
  return <div ref={block} data-answer-steps className="mb-2 scroll-mt-[max(3rem,calc(var(--pane-head,1.25rem)+1rem))]">
    <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}
      className="group/steps inline-flex max-w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-full border border-line px-2.5 py-1 text-xs text-soft outline-none hover:bg-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-ring aria-expanded:bg-hover aria-expanded:text-ink narrow:min-h-10 narrow:px-3">
      <Icon name="code" className="size-3.5 flex-none text-muted group-hover/steps:text-ink" />
      <span className="min-w-0 truncate">{count === undefined ? t('now.step.answered') : t('now.step.answeredCount', { count })}</span>
      <Chevron open={open} /></button>
    {open && <StepList steps={steps} className={CHAT_LOG} />}
  </div>;
}

/**
 * Why a turn failed: its Run's known cause (the words shared with a Run's failure), else the limit its last AI of the
 * stack stopped on, else what serve recorded.
 */
export function coordinatorErrorReason({ error, failure, attempts }: Pick<CoordinatorTurn, "error" | "failure" | "attempts">): string {
  const cause = failure?.cause ?? attempts?.at(-1)?.availability?.cause;
  if (cause) return causeReason(cause, i18n.getFixedT(null, "ui"));
  switch (error) {
    case "attachment_save": return i18n.t("ui:coordinatorCard.error.attachmentSave");
    case "attachment": return i18n.t("ui:coordinatorCard.error.attachment");
    case "config": return i18n.t("ui:coordinatorCard.error.config");
    case "conversation_busy": return i18n.t("ui:coordinatorCard.error.conversationBusy");
    case "exit": return i18n.t("ui:coordinatorCard.error.exit");
    case "internal": return i18n.t("ui:coordinatorCard.error.internal");
    case "interrupted": return i18n.t("ui:coordinatorCard.error.interrupted");
    case "launch": return i18n.t("ui:coordinatorCard.error.launch");
    case "output": return i18n.t("ui:coordinatorCard.error.output");
    case "server": return i18n.t("ui:coordinatorCard.error.server");
    case "timeout": return i18n.t("ui:coordinatorCard.error.timeout");
    case "too_large": return i18n.t("ui:coordinatorCard.error.tooLarge");
    case "unreadable": return i18n.t("ui:coordinatorCard.error.unreadable");
    case null: return i18n.t("ui:coordinatorCard.unknown");
  }
}

/** Marks only unambiguous task references in the coordinator's text. */
export function MentionMarks({ text }: { text: string }) {
  const index = useEveryTaskIndex();
  const ids = [...new Set(taskTokens(text, id => resolveReference(id, index)).map(token => token.id))];
  if (!ids.length) return null;
  const rows = (id: string) => `[data-row="${id}"]`;
  return <style>{ids.map((id) => `${rows(id)}>[data-row-head]>[data-row-label]{background:var(--mention)}`).join("\n")}</style>;
}

/**
 * The AIs of the stack one message went through, when one stopped on a limit: each that stopped and why, then the one
 * that took it over. Said under the answer (or the failure) in the conversation's small words; the last one stopping
 * is the failure itself, said above as every failure is.
 */
export function Attempts({ turn }: { turn: Pick<CoordinatorTurn, "attempts"> }) {
  const { t } = useTranslation("ui");
  const attempts = turn.attempts ?? [];
  if (!attempts.some(attempt => attempt.availability)) return null;
  return <ol data-coordinator-attempts aria-label={t("coordinatorCard.attempts.title")} className="m-0 mt-type-close list-none p-0 text-xs text-muted">
    {attempts.map((attempt, at) => {
      const label = `${attempt.agent} ${agentLabel(attempt.values.model, attempt.values.effort, attempt.agent)}`;
      return <li key={at} data-attempt={attempt.availability ? "stopped" : "took-over"} className="flex gap-1.5">
        <span className="tabular-nums">{at + 1}.</span>
        <span>{attempt.availability ? t("coordinatorCard.attempts.stopped", { agent: label, reason: limitName(attempt.availability.cause, t) })
          : t("coordinatorCard.attempts.tookOver", { agent: label })}</span></li>;
    })}
  </ol>;
}
