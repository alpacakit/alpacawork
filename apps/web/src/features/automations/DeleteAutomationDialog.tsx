import { useTranslation } from "react-i18next";
import type { Automation } from "./shape";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogClose, DialogContent, DialogFooter, DialogHeading } from "@/components/ui/dialog";
import { FieldError } from "@/components/ui/field";
import { problemText } from "@/features/forms/problem-text";

/**
 * Deleting an automation, asked once before it is sent, as archiving a project is (ArchiveProjectDialog): which one,
 * by its number and name, and what deleting leaves (the tasks it made stay; it cannot be brought back). A refusal is
 * said in the same dialog.
 */
export function DeleteAutomationDialog({ automation, onOpenChange, onDelete, pending, failure }: {
  automation: Pick<Automation, "id" | "name">; onOpenChange: (open: boolean) => void; onDelete: () => void;
  pending: boolean; failure: unknown;
}) {
  const { t } = useTranslation("automations");
  return <Dialog open onOpenChange={onOpenChange}>
    <DialogContent data-automation-delete-confirm>
      <DialogHeading title={<span className="[word-break:auto-phrase]">{t("deleteDialog.title", { id: automation.id, name: automation.name })}</span>} />
      <DialogBody>
        <ul className="m-0 flex list-disc flex-col gap-1.5 ps-5 text-base">
          <li>{t("deleteDialog.keeps")}</li>
          <li>{t("deleteDialog.final")}</li>
        </ul>
        {failure !== undefined && failure !== null && <FieldError className="mt-type-block">{problemText(failure)}</FieldError>}
        <DialogFooter>
          <DialogClose asChild><Button variant="outline" disabled={pending}>{t("deleteCancel")}</Button></DialogClose>
          <Button data-automation-delete-yes disabled={pending} onClick={onDelete}>{t("delete")}</Button>
        </DialogFooter>
      </DialogBody>
    </DialogContent>
  </Dialog>;
}
