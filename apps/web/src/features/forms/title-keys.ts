import type { KeyboardEvent } from "react";
import { useWriteDisabled } from "@/data/queries";
import { useWorkspaceStore } from "@/data/workspace-store";
import { isRunEnded } from "@alpacawork/contract/run";
import { crewOf, type PeopleIndex } from "@/domain/people";
import type { Task } from "@/data/types";
import { openForTask, openInput } from "@/state/open-input";
import { useViewStore } from "@/state/view-store";
import { focusCoordinator as focusComposer } from "@/features/coordinator/editor/draft";
import { onScreen, useSitting, type ReaderCard } from "@/features/reader/next-question";
import { placesResponsible } from "./ResponsibleInputs";
import { useReportOpeningDisabled } from '@/features/reader/use-task-report';

type FormAction = "report" | "responsible" | "move";

/**
 * Title keys open their task, then its input (`openForTask`). The state form answers for the reader's card on that
 * task as the key is pressed (none when the reader shows another task or is closed).
 */
function openTaskAction(task: Task, form: FormAction) {
  const { card } = useSitting.getState();
  const answerCard = onScreen(card, task.id) ? card : null;
  openForTask(task.id, () => openTaskActionNow(task, form, answerCard));
}

function openTaskActionNow(task: Task, form: FormAction, answerCard: ReaderCard | null) {
  const view = useViewStore.getState();
  if (form === "report") {
    view.openTask(task.id, { reader: true });
    openInput({ form, taskId: task.id, answerCard });
  } else {
    view.select(task.id);
    openInput({ form, taskId: task.id });
  }
}

/**
 * Whether the A key may open a responsible on a task: only where a person decides one (`placesResponsible`) and not in
 * place of one with unfinished runs.
 */
function opensResponsible(task: Task, people: PeopleIndex) {
  const responsible = crewOf(task.id, people).responsible;
  const responsibleBusy = !!responsible && (people.runsByPlacement.get(responsible.id) ?? []).some((r) => !isRunEnded(r.state));
  return placesResponsible(task) && !responsibleBusy;
}

/**
 * Keys on a card's title: ⇧Enter the full text,
 * R/A/M open reports, responsible assignment and parent editing. A Task's values are its agents' to write (CLI).
 * Reports can be prepared offline; A opens only where the task allows it. The screen makes no Task: the coordinator does.
 */
export function useTitleKeys(task: Task) {
  const writeDisabled = useWriteDisabled();
  const reportDisabled = useReportOpeningDisabled(task.id);
  const store = useWorkspaceStore();
  return (event: KeyboardEvent<HTMLElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey || event.nativeEvent.isComposing) return;
    // S: open the detail with its input focused.
    if (event.key.toLowerCase() === "s") {
      event.preventDefault();
      useViewStore.getState().openTask(task.id, { reader: true, pane: "task" });
      focusComposer();
      return;
    }
    if (event.key === "Enter" && event.shiftKey) { event.preventDefault(); useViewStore.getState().openReader(task.id); return; }
    const form = ({ r: "report", a: "responsible", m: "move" } as const)
      [event.key.toLowerCase() as "r" | "a" | "m"];
    if (!form) return;
    if (form === 'report' ? reportDisabled : writeDisabled) return;
    if (form === "responsible" && !opensResponsible(task, store.getState().people)) return;
    event.preventDefault();
    openTaskAction(task, form);
  };
}
