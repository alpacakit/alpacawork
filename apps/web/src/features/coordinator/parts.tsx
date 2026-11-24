import { useTranslation } from "react-i18next";
import { i18n } from "@alpacawork/i18n";
import type { CoordinatorTurn } from "@/data/coordinator";
import { useEveryTaskIndex } from "@/data/queries";
import { resolveReference } from "@/domain/tasks";
import { taskTokens } from "./editor/wire";
import { useContext, useEffect, useLayoutEffect, useReducer, useSyncExternalStore } from 'react';
import { WorkspaceContext } from '@/data/workspace-store';
import { useConversation } from './coordinator';
import { paceKey, workPacer, type Pace } from './work-pace';
import { workNameWords } from '@/domain/work-words';
import { causeReason, limitName } from '@/domain/run-labels';
import { agentLabel } from '@/domain/agent-label';
import { RunSteps } from '@/features/people/RunSteps';
import { MarkdownBody } from '@/features/reader/MarkdownBody';
import { followTask } from './follow-task';

/**
 * The words of a running turn: its recent work's name while the pacer shows it for this turn, else the turn's own, then
 * the whole seconds since the message was sent (`at`, kept with the message, so neither the work nor a remount, reload
 * or reconnect restarts them). With no running turn given, or `plain` (where the steps themselves are shown), the turn's own words alone.
 */
export function useWorkingWords(turn?: { id: string; at: string }, plain = false): string {
  const { t } = useTranslation('ui');
  const store = useContext(WorkspaceContext);
  const pacer = store ? workPacer(store) : idle;
  const pace = useSyncExternalStore(pacer.subscribe, pacer.snapshot);
  const conversation = useConversation(state => state.conversation?.id);
  // The hold starts when the words reach the DOM, not when a value arrives or a timer fires.
  useLayoutEffect(() => pacer.committed(pace.version), [pacer, pace.version]);
  const words = !plain && pace.label && conversation && turn && pace.key === paceKey(conversation, turn.id)
    ? workNameWords(pace.label) : t('coordinatorCard.thinking');
  const seconds = useSecondsSince(turn?.at);
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

/** The running turn's latest steps as they are, for the open conversation; the folded one keeps to the rounded words. */
export function WorkingSteps({ turn }: { turn: { id: string } }) {
  const store = useContext(WorkspaceContext);
  const work = useSyncExternalStore(store?.subscribe ?? noStore, () => store?.getState().info.coordinatorWork ?? null);
  const conversation = useConversation(state => state.conversation?.id);
  if (!work || work.conversation !== conversation || work.turn !== turn.id) return null;
  return <>
    {work.words && <div data-working-words dir="auto" className="mb-2 [overflow-wrap:anywhere]"><MarkdownBody text={work.words} task={null} variant="note" onFollow={followTask} /></div>}
    <RunSteps steps={work.steps} brief={false} last={5} className="mb-2" />
  </>;
}
const noStore = () => () => {};
/** A mark while waiting for an answer: a quiet pulse of opacity alone. */
export function Thinking({ turn, plain }: { turn: { id: string; at: string }; plain?: boolean }) {
  const words = useWorkingWords(turn, plain);
  return <span data-ask-thinking className="text-muted tabular-nums motion-safe:animate-pulse">{words}</span>;
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
