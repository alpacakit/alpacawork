import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { ConsequenceNote } from "@/components/ui/consequence-note";
import { Dialog, DialogBody, DialogClose, DialogContent, DialogFooter, DialogHeading } from "@/components/ui/dialog";
import { FieldError } from "@/components/ui/field";
import { StateLabel } from "@/components/ui/state-label";
import { problemText } from "@/features/forms/problem-text";
import type { ArchiveRefusal } from "./archive-types";

/**
 * Archiving a project, asked once before it is sent: what leaves the list, what stays, and where it is restored from
 * (the settings' Archive tab), in three short lines, and that a project archived on its own below stays archived when this
 * one is restored. Serve decides whether it may be archived; its refusal comes back as `refusal` and is shown in the same
 * dialog, with the Tasks still at work and no way to stop them here. Counts and dates are not shown.
 */
export function ArchiveProjectDialog({ title, onOpenChange, onArchive, pending, checking, failure, refusal }: {
  title: string; onOpenChange: (open: boolean) => void; onArchive: () => void;
  pending: boolean; checking: boolean; failure: unknown; refusal: ArchiveRefusal | null;
}) {
  const { t } = useTranslation("panels");
  return <Dialog open onOpenChange={onOpenChange}>
    <DialogContent data-archive-confirm={refusal ? "refused" : "ask"}>
      {refusal ? <>
        <DialogHeading title={<span className="[word-break:auto-phrase]">{t("archive.refused.title", { title })}</span>} description={t("archive.refused.description")} />
        <DialogBody>
          <ul className="m-0 flex list-none flex-col gap-2 p-0 text-base">
            {refusal.tasks.map((task) => <li key={task.id} className="flex min-w-0 items-center gap-2">
              {task.state && <StateLabel state={task.state} />}
              <span className="flex-none text-sm text-muted tabular-nums">{task.id}</span>
              {task.title && <span className="min-w-0 truncate">{task.title}</span>}
            </li>)}
            {refusal.runs.length > 0 && <li className="text-sm text-muted">{t("archive.refused.runs", { runs: refusal.runs.join(", ") })}</li>}
          </ul>
          <DialogFooter>
            <DialogClose asChild><Button>{t("archive.refused.close")}</Button></DialogClose>
          </DialogFooter>
        </DialogBody>
      </> : <>
        <DialogHeading title={<span className="[word-break:auto-phrase]">{t("archive.confirm.title", { title })}</span>} />
        <DialogBody>
          <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2.5 text-base narrow:grid-cols-1 narrow:gap-y-0">
            <dt className="font-medium whitespace-nowrap narrow:text-sm narrow:font-normal narrow:text-muted">{t("archive.confirm.leaves")}</dt>
            <dd className="m-0 narrow:mb-2">{t("archive.confirm.leavesValue")}</dd>
            <dt className="font-medium whitespace-nowrap narrow:text-sm narrow:font-normal narrow:text-muted">{t("archive.confirm.keeps")}</dt>
            <dd className="m-0 narrow:mb-2">{t("archive.confirm.keepsValue")}</dd>
            <dt className="font-medium whitespace-nowrap narrow:text-sm narrow:font-normal narrow:text-muted">{t("archive.confirm.restore")}</dt>
            <dd className="m-0">{t("archive.confirm.restoreValue")}</dd>
          </dl>
          <ConsequenceNote>
            <span className="[word-break:auto-phrase]">{t("archive.confirm.insideGeneral")}</span>
          </ConsequenceNote>
          {checking && <FieldError className="mt-type-block">{t("forms:writeFailure.operationUnconfirmed")}</FieldError>}
          {!checking && failure !== undefined && failure !== null && <FieldError className="mt-type-block">{problemText(failure)}</FieldError>}
          <DialogFooter>
            <DialogClose asChild><Button variant="outline" disabled={pending}>{t("archive.confirm.cancel")}</Button></DialogClose>
            <Button data-archive-submit disabled={pending} onClick={onArchive}>
              {pending ? t("archive.confirm.pending") : checking ? t("reader:recovery.check") : t("archive.confirm.submit")}
            </Button>
          </DialogFooter>
        </DialogBody>
      </>}
    </DialogContent>
  </Dialog>;
}
