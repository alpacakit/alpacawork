import { rowWriteBasis } from "@/data/connection";
import { ApiError, retryOf } from "@/data/client";
import { useWorkspaceInfo } from "@/data/queries";
import { intentKey } from "@/data/write-intent";
import { notify } from "@/lib/notify";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { sendDirectIntent } from "@/data/direct-write";

type LifecycleAction = "archive" | "delete" | "restore";
/**
 * Archive, delete and restore: logical changes of a task's lifecycle, checked
 * against the hash on screen. Taking a task out of the tree offers Undo.
 */
export function useLifecycle() {
  const client = useQueryClient();
  const root = useWorkspaceInfo(info => info.root);
  const change = useMutation({
    meta: { errorToast: false },
    mutationFn: ({ action, id, expectedTaskHash }: { action: LifecycleAction; id: string; expectedTaskHash: string }) =>
      sendDirectIntent(client, intentKey(root, `task/${action}`, id), { path: `task/${action}`, response: "task", label: id },
        () => ({ task: id, expectedTaskHash }), rowWriteBasis(id, expectedTaskHash)),
    onError: error => { if (!(error instanceof ApiError && error.code === "cancelled") && retryOf(error) !== "check") notify.failure(error, { about: "task lifecycle" }); },
  });
  return change;
}
