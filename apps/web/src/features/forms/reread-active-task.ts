import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { rereadWorkspaceIndex } from "@/data/queries";
import { notify } from "@/lib/notify";
import { closeInput } from "@/state/open-input";

/** Read the latest list and this Task's row in it. A Task no longer there or no longer active is said, and its form closes (null). */
export function useRereadActiveTask(taskId: string) {
  const client = useQueryClient();
  const { t } = useTranslation("forms");
  return async () => {
    const latest = await rereadWorkspaceIndex(client);
    const row = latest.tasks.find(each => each.id === taskId);
    if (!row || row.lifecycle !== "active") { notify.error(t("responsibleForm.taskUnavailable")); closeInput(); return null; }
    return { latest, row };
  };
}
