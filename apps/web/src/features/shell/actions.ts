import { useTranslation } from "react-i18next";
import { notify } from "@/lib/notify";
import { queryClient } from "@/data/query-client";
import type { ProjectedIndexDTO } from "@alpacawork/contract/control";
import { indexKey } from "@/data/resources";
import { reportReadResult, useReadStore } from "@/state/read-store";
import { serverReadFacts } from "@/data/read-model";

/**
 * Operations that more than one part of the page offers, each with its toast,
 * so every button that runs one behaves the same (mark all read, reconnect).
 */

/** "Mark all as read" above a narrowed list: mark the tasks it shows read, with "Undo"; unread tasks outside it stay unread. */
export function useMarkShownRead() {
  const { t } = useTranslation("ui");
  return async (shown: readonly { id: string }[]) => {
    const index = queryClient.getQueryData<ProjectedIndexDTO>(indexKey);
    const ids = new Set(shown.map((task) => task.id));
    // Retained rows of an unreadable scan are not current facts to acknowledge.
    const tasks = index && (serverReadFacts(queryClient)?.tasks ?? []).filter((task) => ids.has(task.id) && !index.staleIds.includes(task.id));
    if (!tasks) return;
    const result = await useReadStore.getState().confirm(tasks);
    reportReadResult(tasks.map(task => task.id), result, index);
    if (result === true) notify.success(t("allRead.done"), {
      action: { label: t("allRead.undo"), run: () => { void useReadStore.getState().undoAllRead(); } },
    });
  };
}

