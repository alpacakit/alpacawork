import { useRef } from "react";
import { checkDirectIntent } from "@/data/direct-write";
import { intentKey, useWriteIntent } from "@/data/write-intent";
import { useTranslation } from "react-i18next";
import { notify } from "@/lib/notify";
import { useQueryClient } from "@tanstack/react-query";
import type { ControlRunDTO } from "@alpacawork/contract/control";
import { runStopInput } from "@alpacawork/contract/inputs";
import { rereadWorkspaceIndex, useStopRun, useWorkspaceInfo } from "@/data/queries";
import { useDialogStore, type RunFormTarget } from "@/state/dialog-store";
import { FormDialog } from "./FormDialog";
import { useServerForm } from "./server-form";

/**
 * The modal confirmation for Close (close a review). Targets are looked up in the current snapshot; a
 * missing target opens nothing.
 */
export function RunFormDialog({ target }: { target: RunFormTarget }) {
  const runs = useWorkspaceInfo((info) => info.runs);
  const run = runs.find((item) => item.id === target.runId);
  if (!run) return null;
  return <RunActionForm run={run} />;
}

function RunActionForm({ run }: { run: ControlRunDTO }) {
  const { t } = useTranslation("forms");
  const client = useQueryClient();
  const root = useWorkspaceInfo(info => info.root);
  const key = intentKey(root, "run/stop", run.id);
  const intent = useWriteIntent(key);
  const opening = useRef(useDialogStore.getState().dialog);
  const stop = useStopRun({ errorToast: false });
  const form = useServerForm({ schema: runStopInput, defaultValues: { run: run.id }, fieldPaths: [],
    submit: async () => {
      await stop.mutateAsync(run);
      if (useDialogStore.getState().dialog === opening.current) {
        useDialogStore.getState().close();
        notify.success(t("runForm.closed"));
      }
    },
  });
  const reread = async () => {
    if (intent.status === "unconfirmed") {
      await checkDirectIntent(client, key);
      form.clearFailure();
      return;
    }
    const latest = await rereadWorkspaceIndex(client);
    const current = latest.runs.find(each => each.id === run.id);
    if (!current || current.state !== "needs_review") {
      notify.info(t("runForm.noLongerAvailable"));
      useDialogStore.getState().close();
      return;
    }
    form.clearFailure();
  };
  return (
    <FormDialog title={t("runForm.closeTitle")}
      description={t("runForm.closeDescription", { run: run.id })}
      submitLabel={t("runForm.closeSubmit")} form={form} onReread={reread}
      checkMessage={t("writeFailure.operationUnconfirmed")} checkRequired={intent.status === "unconfirmed"} checking={key} rereadLabel={intent.status === "unconfirmed" ? t("reader:recovery.check") : undefined}
      disabled={intent.unavailable || intent.status === "pending" || intent.status === "unconfirmed"} />
  );
}
