import { useEffect, useRef } from "react";
import type { ReaderCard } from "@/features/reader/next-question";
import { navigate } from "@/lib/history";
import { useDialogStore, type InputForm, type OpenInput } from "./dialog-store";
import { shownInReader, useViewStore } from "./view-store";

/**
 * Every input opens in the reader, for the task it shows: the state popover where the state is shown (reader header),
 * the responsible and move sections, and the body editor in the reader's task pane (the reader opens first). The screen
 * makes no Task: a Task is asked of the coordinator.
 */
type OpenRequest =
  | { form: "report"; taskId: string; answerCard: ReaderCard | null }
  | { form: "responsible" | "move"; taskId: string };

/**
 * What opens the task it is for and then its input is one intent (lib/history.ts): the input opens where the reader then
 * is, the reader's own input ending with the task it was for. One for the task the reader shows acts on that reader as it
 * is (pressed in it, or for it): closed meanwhile (its × under way), it opens nothing.
 */
export function openForTask(taskId: string, run: () => void) {
  navigate(run, { bound: shownInReader(useViewStore.getState()) === taskId });
}

/** One that opens the reader first goes with it (`openForTask`); one on the reader as it is opens at once. */
export function openInput(request: OpenRequest) {
  if (request.form === "responsible" || request.form === "move")
    openForTask(request.taskId, () => openNow(request));
  else openNow(request);
}

function openNow(request: OpenRequest) {
  const dialogs = useDialogStore.getState();
  const view = useViewStore.getState();
  switch (request.form) {
    case "report":
      return dialogs.openInput({ form: "report", taskId: request.taskId, answerCard: request.answerCard });
    case "responsible":
    case "move":
      if (shownInReader(view) !== request.taskId) view.openTask(request.taskId, { reader: true });
      return dialogs.openInput({ form: request.form, taskId: request.taskId });
  }
}

/** The open input, if it is `form` for `taskId`. */
export function useOpenInput(form: InputForm, taskId: string | null): OpenInput | null {
  return useDialogStore((state) => {
    const dialog = state.dialog;
    if (!dialog || dialog.kind !== "input" || dialog.form !== form || dialog.taskId !== taskId) return null;
    return dialog;
  });
}

/**
 * A display operation of the same Task continues its reader input session. The view marks its task identity;
 * controls that open another input or navigate away still go through the dialog/view Owners themselves.
 * Everything else remains an outside press (including the reader's document and the tree).
 */
export function continuesInputSession(target: Element) {
  const input = useDialogStore.getState().dialog, view = useViewStore.getState();
  return input?.kind === 'input' && shownInReader(view) === input.taskId
    && target.closest('[data-input-view]')?.getAttribute('data-input-view') === input.taskId;
}

export const closeInput = () => useDialogStore.getState().close();

/**
 * When an in-place input closes and nothing else took the focus, give it back
 * to the element that opened it (`selector`), as a closed dialog does.
 */
export function useFocusBack(open: boolean, selector: string) {
  const was = useRef(open);
  useEffect(() => {
    if (was.current && !open) requestAnimationFrame(() => {
      const active = document.activeElement;
      if (active && active !== document.body) return;
      document.querySelector<HTMLElement>(selector)?.focus({ preventScroll: true });
    });
    was.current = open;
  }, [open, selector]);
}
