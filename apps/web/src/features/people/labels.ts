import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { userTurn } from "@alpacawork/contract";
import { usePeopleFor, useTaskIndexFor } from "@/data/queries";
import { estimateOf } from "@/domain/estimate";
import { finishFacts, finishOf, finishWords, type FinishFacts, type FinishWords } from "@/domain/finish-words";
import { placedOn, type PeopleIndex } from "@/domain/people";
import type { RunActivity } from "@alpacawork/contract/run";
import { minutesSince } from "@/domain/time";
import { useNow } from "@/state/clock";
import { stateSince, type TaskIndex } from "@/domain/tasks";
import { workWords } from '@/domain/work-words';
import { outputIsQuiet } from '@/domain/run-activity';

/** What one task's own state and records say of its end (domain/finish-words). */
function ownFinishFacts(taskId: string, people: PeopleIndex, now: number): FinishFacts | null {
  const control = people.tasks.get(taskId);
  if (!control) return null;
  const since = stateSince(control);
  const placed = placedOn(taskId, people);
  return finishFacts({ state: control.state,
    interrupted: placed.some((placement) => placement.runtime.displayState === "attention"),
    working: placed.some((placement) => placement.runtime.displayState === "running"),
    estimate: estimateOf(control, now), since: since ? Date.parse(since) : null, turn: userTurn(control.ball) !== null });
}

/** When the task reports, with the tasks under it, in the "Expected report" words (domain/finish-words); null when there is nothing to say. */
export function useFinishWords(taskId: string): FinishWords | null {
  const { t } = useTranslation("people");
  const people = usePeopleFor(taskId, true);
  const index = useTaskIndexFor(taskId);
  const now = useNow();
  return finishWordsFor(taskId, index, people, now, t);
}

/** What is known of when a task reports, with the tasks under it (domain/finish-words finishOf). */
export function finishFactsFor(taskId: string, index: TaskIndex, people: PeopleIndex, now: number): FinishFacts | null {
  return finishOf(taskId, { index, now, factsOf: (id) => ownFinishFacts(id, people, now) });
}

/** The same end words for a list of visible rows, without one hook per row in the time axis. */
export function finishWordsFor(taskId: string, index: TaskIndex, people: PeopleIndex, now: number,
  t: (key: string, options?: Record<string, unknown>) => string): FinishWords | null {
  const facts = finishFactsFor(taskId, index, people, now);
  return facts && finishWords(facts, now, t);
}

/** "43m", "2h 6m", "3d"; null when the start is not known. */
export function useDuration() {
  const { t } = useTranslation("people");
  const now = useNow();
  return (since: string | null): string | null => {
    const minutes = minutesSince(since, now);
    if (minutes === null) return null;
    if (minutes < 1) return t("duration.underMinute");
    if (minutes < 60) return t("duration.minutes", { count: minutes });
    if (minutes < 24 * 60) return t("duration.hours", { hours: Math.floor(minutes / 60), minutes: minutes % 60 });
    return t("duration.days", { count: Math.floor(minutes / (24 * 60)) });
  };
}

/**
 * What is known of a person now, in set phrases from the backend's runtime:
 * the reason for attention, or the last complete stdout event of a running
 * person. A tool start does not claim that the tool is still running.
 */
export function useActivityText() {
  const { t } = useTranslation("people");
  const duration = useDuration();
  const now = useNow();
  return (activity: RunActivity | null): string => {
    if (!activity) return "";
    const ago = duration(activity.at);
    if (ago === null) return "";
    const stale = outputIsQuiet(Date.parse(activity.at), now);
    if (activity.doing?.command) {
      const event = workWords(activity.doing.command);
      return stale ? t('now.stale', { event, ago }) : event;
    }
    const kind = activityKindWord(activity.kind, t);
    const event = activity.toolName
      ? t("now.toolEvent", { tool: activity.toolName, kind })
      : t("now.event", { kind });
    return stale ? t("now.stale", { event, ago }) : t("now.output", { event, ago });
  };
}

function activityKindWord(kind: RunActivity["kind"], t: TFunction<"people">): string {
  switch (kind) {
    case "output": return t("people:now.kind.output");
    case "tool_start": return t("people:now.kind.tool_start");
    case "tool_end": return t("people:now.kind.tool_end");
    case "message": return t("people:now.kind.message");
    case "result": return t("people:now.kind.result");
    case "error": return t("people:now.kind.error");
  }
}
