import { Fragment } from "react";
import { useTranslation } from "react-i18next";
import type { ProjectShelfInfo } from "@alpacawork/contract/control";
import { Message } from "@/components/ui/message";
import { ReadFailure } from "@/components/ui/loadable";
import { ProjectTile } from "@/components/ui/project-tile";
import { cn } from "@/lib/utils";
import type { ShelfTarget } from "./archive-types";

/**
 * What an old URL shows when serve says its Task or project is shelved (`task/view` reason `task_archived`): where it is
 * archived (`shelf.shelvedBy`, outermost first, each archived or deleted) and one button that restores what serve names
 * (`shelf.restoreTarget`): "first" when more stays archived after it. Inside a deleted project it says so and offers
 * nothing to restore. `onOpenArchive` opens the settings' Archive tab. No Task view is shown or read here; a visible,
 * unknown or unreadable address is the caller's.
 *
 * `placement`: in the reader, under the frame's own ID and title, or in the list's place (a sentence for a title).
 */
export function ArchivedNotice({ title, shelf, placement, onRestore, onOpenArchive, restoring, restoreDisabled, failure }: {
  title: string; shelf: ProjectShelfInfo; placement: "reader" | "list"; onRestore: (target: ShelfTarget) => void;
  onOpenArchive: () => void; restoring: boolean; restoreDisabled: boolean; failure: unknown;
}) {
  const { t } = useTranslation("panels");
  const target = shelf.restoreTarget;
  const path = <div className={cn("m-0 flex min-w-0 flex-wrap items-start gap-x-1.5 gap-y-2 text-base text-ink", placement === "list" && "justify-center text-start")}>
    {shelf.shelvedBy.map((step, at) => <Fragment key={step.id}>
      {at > 0 && <span aria-hidden="true" className="text-soft">›</span>}
      <span className="inline-flex max-w-full min-w-0 items-start gap-1.5">
        <ProjectTile name={step.title} color={step.color} size={20} className="mt-0.5" />
        <span className="min-w-0">
          <span dir="auto" className="[overflow-wrap:anywhere]">{step.title}</span>
          <span className="ml-1.5 whitespace-nowrap text-sm text-muted tabular-nums">{step.id}</span>
          <ShelfMark lifecycle={step.lifecycle} className="ml-1.5" />
        </span>
      </span>
    </Fragment>)}
  </div>;
  const restore = target ? { label: restoring ? t("archive.notice.restoring")
      : t(shelf.shelvedBy.length > 1 ? "archive.notice.restoreFirst" : "archive.notice.restore", { title: target.title }),
    run: () => onRestore(target), disabled: restoring || restoreDisabled, data: { "data-archive-restore": target.id } } : undefined;
  const open = { label: t("archive.notice.open"), run: onOpenArchive };
  const failed = failure !== undefined && failure !== null && <ReadFailure error={failure} className="mt-3" />;
  if (placement === "list") return <section data-archive-notice="list" className="px-4 pt-16 narrow:pt-10">
    <Message tone="info" icon="archive" title={t(target ? "archive.notice.projectTitle" : "archive.notice.projectDeleted", { title })}
      description={path} action={restore ?? open} secondary={restore && open} />
    {failed && <div className="mx-auto max-w-sm">{failed}</div>}
  </section>;
  // In the reader its frame already names the Task (ID and title, from the location's `task`): only the band here.
  return <section data-archive-notice="reader">
    <Message size="band" tone="info" icon="archive" title={target ? t("archive.notice.inArchived") : t("archive.notice.inDeleted")}
      description={path} action={restore ?? open} secondary={restore && open} />
    {failed}
  </section>;
}

/** The mark beside a project's name that says it is archived or deleted (the settings' project list, a notice's path). */
export function ShelfMark({ lifecycle, className }: { lifecycle: string; className?: string }) {
  const { t } = useTranslation("panels");
  return <span data-shelf-mark={lifecycle} className={cn("inline-block rounded-xs border border-line px-1.5 text-xs text-muted", className)}>
    {lifecycle === "deleted" ? t("archive.notice.deleted") : t("archive.notice.archived")}</span>;
}
