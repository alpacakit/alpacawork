import { useDialogStore } from "@/state/dialog-store";
import { useViewStore } from "@/state/view-store";

export function useMoveToTask() {
  return (id: string) => {
    useDialogStore.getState().close();
    useViewStore.getState().openTask(id, { reader: true });
  };
}
