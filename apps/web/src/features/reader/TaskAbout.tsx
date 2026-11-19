import { useTranslation } from "react-i18next";
import type { Task, TaskDetail } from "@/data/types";
import { Message } from "@/components/ui/message";
import { dayClock } from "@/domain/day-clock";
import { useNow } from "@/state/clock";
import { useFieldCatalog } from "@/data/fields";
import { shownContext } from "@/domain/field-display";
import { MarkdownBody } from "./MarkdownBody";

/**
 * The Task's context: its values as its launches carry them (contract renderContext, the server's text, with shipped
 * field titles in the reader's language: domain/field-display), drawn as
 * Markdown on the reader's Context page, opened from the entry under the title. They stand nowhere beside the
 * reports. Its agents write the values (CLI); the page only reads them.
 */
export function TaskAbout({ task, onFollow }: { task: TaskDetail; onFollow: (id: string) => void }) {
  const { t } = useTranslation("reader");
  const { fields, catalog } = useFieldCatalog();
  // Shipped field titles in the reader's language; the server's text is what launches carry.
  const context = shownContext(task.values, fields ? catalog : null);
  return <div data-task-about className="pb-6" dir="auto">
    <TaskDates task={task} />
    {/* Its own box, so what comes first is first here and starts level with the dates, which it wraps around. */}
    <div data-task-context>
      {context ? <MarkdownBody text={context} task={task} onFollow={onFollow} />
        : <Message tone="empty" size="line" className="mt-type-section first:mt-0" title={t("overview.empty")} />}
    </div>
  </div>;
}

/**
 * When the task began and when its record last moved (its first and latest log entries), as every timeline says a time.
 * Until a later time can be told from its creation there is one time to say. It stands at the end of the page's first
 * line: seen on opening, on any width, without pushing the goal down or being read before it. Only a fact's heading or
 * the empty note stands beside it: a body may open with code, a table or a picture, so it starts below.
 */
function TaskDates({ task }: { task: Task }) {
  const { t } = useTranslation("reader");
  const { t: people } = useTranslation("people");
  const now = useNow();
  const when = (at: string | null | undefined) => at ? dayClock(Date.parse(at), now, people) : "";
  const created = when(task.createdAt);
  const updated = when(task.updatedAt);
  const moved = updated && updated !== created;
  if (!created && !moved) return null;
  return <p data-task-dates className="float-end mt-0 mb-1 ms-4 pt-0.75 text-xs text-muted tabular-nums">
    {created && <time data-task-created dateTime={task.createdAt!}>{t("overview.createdAt", { time: created })}</time>}
    {created && moved && " · "}
    {moved && <time data-task-updated dateTime={task.updatedAt}>{t("overview.updatedAt", { time: updated })}</time>}
  </p>;
}
