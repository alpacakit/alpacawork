import { captureReadBoundary, sameReadSession } from '@/data/read-model';
import { queryClient } from '@/data/query-client';
import { useDialogStore } from "@/state/dialog-store";

/** Saving affects the opening that initiated it, never a later opening of the same field. */
export function afterSave<T extends unknown[]>(callback: ((...args: T) => void) | undefined): (...args: T) => void {
  const opened = useDialogStore.getState().dialog;
  const boundary = captureReadBoundary(queryClient);
  return (...args) => { if (sameReadSession(queryClient, boundary) && useDialogStore.getState().dialog === opened) callback?.(...args); };
}
