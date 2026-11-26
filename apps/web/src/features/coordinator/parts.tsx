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

/* Hallmark · component: a turn's work in the open conversation, from its run to its answer · genre: modern-minimal ·
 * theme: the app's own tokens · states: at work with nothing run yet (the mark, "Working on it…", the seconds) · at work
 * (the latest words, then the mark, the step, the seconds, ⌄) · at work, open (the line counts the steps, every step so
 * far under it, ⌃) · answered (one quiet line at the answer's left edge: its words, then ›) · answered, open (the line
 * counts the steps, ⌄, the steps' box under it, then the answer) · reading · not readable */
/**
 * A turn's work, where the conversation is open, as one thing from its start to its answer. At work: its latest words,
 * then one line that says it all (the moving mark, the latest step or that it works, the seconds since the message),
 * which opens every step so far under it. Answered: one quiet line, as wide as its words and at the answer's left
 * edge, in that line's place, as far from the message over it as from the answer under it. It is the same press and
 * the same list throughout, so what was opened or closed, a step opened in it and the focus in it stay as they are
 * when the answer comes; the list is read only while open, and once more when the work ends, so no step is left at
 * work.
 */
export function TurnWork({ turn }: { turn: Pick<CoordinatorTurn, 'id' | 'at' | 'status' | 'workedBy'> }) {
  const { t } = useTranslation('ui'), { t: p } = useTranslation('people');
  const store = useContext(WorkspaceContext);
  const conversation = useConversation(state => state.conversation?.id);
  // Only this turn's work is taken: any other turn's (the one at work, for an answered turn) is null here, so its updates
  // draw nothing again on turns they are not about.
  const received = useSyncExternalStore(store?.subscribe ?? noStore, () => {
    const work = store?.getState().info.coordinatorWork;
    return work && work.conversation === conversation && work.turn === turn.id ? work : null;
  });
  const [open, setOpen] = useState(false);
  // Offline, the last work received says nothing of now: as the folded words drop it (work-pace), so do these.
  const offline = useConnection(state => state.offline);
  // The turn's work, as last received for it: the Run's work ends a moment before the turn's answer comes, and until the
  // answer takes its place the turn keeps saying what it did, so nothing under it is taken away and put back.
  const last = useRef(received);
  if (received) last.current = received;
  const kept = last.current && last.current.conversation === conversation ? last.current : null;
  const mine = offline ? null : received ?? kept;
  const running = turn.status === 'running';
  // At work, the Run is the one working on it; answered, the one that answered (the same Run, so the list stays).
  const run = running ? mine?.run : turn.workedBy;
  // Whether there is a list is whether the Run has taken any step (tookSteps), as everywhere its steps are offered.
  const worked = running ? tookSteps(mine) : !!turn.workedBy;
  // Brought up to date whenever any of its steps starts or ends, however many run at once, and once more as it ends.
  const steps = useRunSteps(run, open && worked, running ? mine?.stepEvents ?? 0 : 'ended');
  const block = useRef<HTMLDivElement>(null);
  // Opened after the answer, the pill goes to the top where it must move, so the answer's start stays in sight under it.
  // Brought into sight as it is shown: at once with what was read before, else once the first read answers.
  useListedInSight(open ? steps.listed : null, block, !running);
  // How many steps, said on the line while they are listed under it; folded, the line says the latest step.
  const count = open ? stepCount(steps) : undefined;
  if (!running && !turn.workedBy) return null;
  const toggle = () => setOpen(!open);
  return <div>
    {running && mine?.words && <div data-working-words dir="auto" className="mb-2 [overflow-wrap:anywhere]"><MarkdownBody text={mine.words} task={null} variant="note" onFollow={followTask} /></div>}
    {/* The work line beside the message, at the size of its other states and the answer's own line. */}
    <div ref={block} data-answer-steps={running ? undefined : ''} className={cn("scroll-mt-[max(3rem,calc(var(--pane-head,1.25rem)+1rem))] text-xs", !running && ANSWERED_PLACE)}>
    {!worked ? <WorkLine data-ask-thinking step={undefined} idle={t('coordinatorCard.thinking')} end={<WorkSeconds at={turn.at} />} />
      : <button type="button" data-turn-work-line data-working-steps={running ? '' : undefined} aria-expanded={open} onClick={toggle} className={running ? STEPS_BUTTON : ANSWERED_LINE}>
        {running ? <WorkLine data-ask-thinking step={mine?.steps.at(-1)} idle={t('coordinatorCard.thinking')} label={count === undefined ? undefined : p('now.step.count', { count })}
          className="min-w-0 flex-1 group-hover/steps:text-ink" end={<><WorkSeconds at={turn.at} /><Chevron open={open} /></>} />
        : <><span className="min-w-0 truncate">{count === undefined ? p('now.step.answered') : p('now.step.answeredCount', { count })}</span>
          <Icon name="right" className={cn("size-3 flex-none text-muted transition-transform duration-(--motion-base) group-hover/steps:text-ink", open && "rotate-90")} /></>}</button>}
    {worked && <StepList steps={steps} open={open} className={cn(CHAT_LOG, !running && ANSWERED_LOG)} />}
  </div></div>;
}
/**
 * A line that opens a Run's steps under it: its whole width a press, a finger's height on a phone. The press overhangs
 * the line evenly, so its words stand where the line's words stand before it can be pressed (and where any other state
 * of a message is said).
 */
const STEPS_BUTTON = "group/steps flex w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-sm -my-1 py-1 text-left outline-none focus-visible:outline-2 focus-visible:outline-ring narrow:min-h-11 narrow:-my-[calc((--spacing(11)-1lh)/2)]";
/**
 * The answered turn's way into its work: one quiet line, its words at the answer's left edge and › after them. On a phone
 * its press is a finger's height, overhanging the line evenly as the line at work does. Its focus ring is the app's own
 * (base.css: shown while the keyboard is in use), so nothing here turns the outline off.
 */
const ANSWERED_LINE = "group/steps inline-flex max-w-full min-w-0 cursor-pointer items-center gap-1 rounded-sm -my-1 py-1 text-left text-muted hover:text-ink aria-expanded:text-ink narrow:min-h-11 narrow:-my-[calc((--spacing(11)-1lh)/2)]";
/**
 * The answered line's letters stand as far from the message over it as from the answer's letters under it. Over it is the
 * conversation's room between blocks (type-block of the answer's line, which the reply keeps over it already); under it,
 * that room less the answer's own half-leading, i.e. half the answer's size. On a phone the press's overhang comes first,
 * so it covers neither the message nor the answer, and the same evenness is kept around it.
 */
const ANSWERED_PLACE = "mt-[calc(var(--text-base)*var(--text-base--line-height)/2)] mb-[calc(var(--text-base)/2)] narrow:mt-[calc((--spacing(11)-1lh)/2+(var(--text-base)*var(--text-base--line-height)-var(--text-base))/2)] narrow:mb-[calc((--spacing(11)-1lh)/2)]";
/** Open under the answered line on a phone, the steps start below the press's overhang, so their first step is pressed as itself. */
const ANSWERED_LOG = "narrow:mt-[calc((--spacing(11)-1lh)/2)]";
/** The conversation is short: its steps' box keeps the answer under it in sight, a step opened in it too. */
const CHAT_LOG = "mt-1 max-h-[min(14rem,35vh)] narrow:max-h-[min(16rem,40vh)] has-[[data-run-step-open]]:max-h-[min(14rem,35vh)] narrow:has-[[data-run-step-open]]:max-h-[min(16rem,40vh)]";
function Chevron({ open }: { open: boolean }) {
  return <Icon name="down" className={cn("size-3.5 flex-none self-center text-muted transition-transform duration-(--motion-base) group-hover/steps:text-ink", open && "rotate-180")} />;
}
/**
 * The steps are read after the press: once first drawn, the line and the list under it come into sight as one place
 * request, the list's head (the line, then "earlier") first. One that does not fit below where it is starts at the top.
 * The list unfolds from nothing (DisclosureBody), so where it goes is measured at the height it unfolds to, and it
 * glides there with the unfolding.
 */
function useListedInSight(read: unknown, block: RefObject<HTMLElement | null>, top = false) {
  const listed = useRef(false);
  useLayoutEffect(() => {
    if (!read) { listed.current = false; return; }
    const element = block.current;
    if (listed.current || !element) return;
    listed.current = true;
    const area = element.closest<HTMLElement>('[data-card-scroll]')?.getBoundingClientRect() ?? { top: 0, bottom: window.innerHeight };
    const body = element.querySelector<HTMLElement>('[data-disclosure-body]');
    const grows = body ? Math.max(0, body.scrollHeight - body.getBoundingClientRect().height) : 0;
    const drawn = element.getBoundingClientRect(), box = { top: drawn.top, bottom: drawn.bottom + grows, height: drawn.height + grows };
    if (box.top < area.top || box.height > area.bottom - area.top || (top && box.bottom > area.bottom)) scrollThreadTo(element, element, { block: 'start' }, grows);
    else if (box.bottom > area.bottom) scrollThreadTo(element, element, { block: 'end' }, grows);
  }, [read, block, top]);
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
