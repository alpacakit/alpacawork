import { useTranslation } from "react-i18next";
import { i18n } from "@alpacawork/i18n";
import type { CoordinatorTurn } from "@/data/coordinator";
import { useEveryTaskIndex } from "@/data/queries";
import { resolveReference } from "@/domain/tasks";
import { taskTokens } from "./editor/wire";
import { useContext, useEffect, useLayoutEffect, useReducer, useRef, useState, useSyncExternalStore, type RefObject } from 'react';
import { WorkspaceContext } from '@/data/workspace-store';
import { useConversation } from './coordinator';
import { paceKey, workPacer, type Pace } from './work-pace';
import { workNameWords } from '@/domain/work-words';
import { causeReason, limitName } from '@/domain/run-labels';
import { agentLabel } from '@/domain/agent-label';
import { StepList, WorkLine, stepCount, useRunSteps } from '@/features/people/RunSteps';
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
  const pressed = useRef(false), end = useRef<HTMLDivElement>(null);
  const seconds = useSecondsSince(turn.at);
  // Opened by a press, the line comes into sight as one place request.
  useLayoutEffect(() => {
    if (!pressed.current || !end.current) return;
    pressed.current = false;
    if (open) scrollThreadTo(end.current, end.current, { block: 'nearest' });
  }, [open]);
  // Offline, the last work received says nothing of now: as the folded words drop it (work-pace), so do these.
  const offline = useConnection(state => state.offline);
  const mine = !offline && work && work.conversation === conversation && work.turn === turn.id ? work : null;
  const step = mine?.steps.at(-1);
  const steps = useRunSteps(mine?.run, open && !!step, step && `${step.id}:${step.state}`);
  useListedInSight(steps.read, end);
  const time = seconds === null ? null : <span data-work-seconds className="flex-none text-muted tabular-nums">{seconds}s</span>;
  const count = stepCount(steps.read);
  return <div ref={end}>
    {mine?.words && <div data-working-words dir="auto" className="mb-2 [overflow-wrap:anywhere]"><MarkdownBody text={mine.words} task={null} variant="note" onFollow={followTask} /></div>}
    {step ? <button type="button" data-working-steps aria-expanded={open} onClick={() => { pressed.current = true; setOpen(!open); }} className={STEPS_BUTTON}>
      <WorkLine data-ask-thinking step={step} label={count === undefined ? undefined : p('now.step.count', { count })} className="min-w-0 flex-1 group-hover/steps:text-ink"
        end={<>{time}<Chevron open={open} /></>} /></button>
      : <WorkLine data-ask-thinking step={undefined} idle={t('coordinatorCard.thinking')} end={time} className="py-1 narrow:min-h-11 narrow:items-center" />}
    {open && step && <StepList steps={steps} className="mt-1" />}
  </div>;
}
/** A line that opens a Run's steps under it: a finger's height on a phone, its whole width a press. */
const STEPS_BUTTON = "group/steps flex w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-sm py-1 text-left outline-none focus-visible:outline-2 focus-visible:outline-ring narrow:min-h-11";
function Chevron({ open }: { open: boolean }) {
  return <Icon name="down" className={cn("size-3.5 flex-none self-center text-muted transition-transform duration-(--motion-base) group-hover/steps:text-ink", open && "rotate-180")} />;
}
/** The steps are read after the press: once they are first drawn, their foot comes into sight as one place request. */
function useListedInSight(read: unknown, end: RefObject<HTMLElement | null>) {
  const listed = useRef(false);
  useLayoutEffect(() => {
    if (!read) { listed.current = false; return; }
    if (listed.current || !end.current) return;
    listed.current = true;
    scrollThreadTo(end.current, end.current, { block: 'nearest' });
  }, [read, end]);
}

/* Hallmark · component: an answered message's steps · genre: modern-minimal · theme: the app's own tokens · states:
 * folded (one quiet line, ⌄) · open (the line counts the steps, every step under it, ⌃) · reading · not readable */
/**
 * The steps of the Run that answered, above its answer where the work line stood while it ran: one quiet line that opens
 * them as that line did, read only once opened. They open downward from it, where the reading starts, so nothing is
 * scrolled for them.
 */
export function AnswerSteps({ run }: { run: string }) {
  const { t } = useTranslation('people');
  const [open, setOpen] = useState(false);
  const steps = useRunSteps(run, open);
  const count = stepCount(steps.read);
  return <div data-answer-steps className="mb-2">
    <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className={cn(STEPS_BUTTON, "text-xs text-muted hover:text-ink")}>
      <span className="min-w-0 flex-1 truncate">{count === undefined ? t('now.step.answered') : t('now.step.answeredCount', { count })}</span>
      <Chevron open={open} /></button>
    {open && <StepList steps={steps} className="mt-1" />}
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
