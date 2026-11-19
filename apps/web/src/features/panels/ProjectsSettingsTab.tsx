import { useTranslation } from "react-i18next";
import type { ProjectShelfDTO } from "@alpacawork/contract/control";
import { Loadable } from "@/components/ui/loadable";
import { Message } from "@/components/ui/message";
import { RegionSkeleton } from "@/components/ui/skeleton";
import { Icon } from "@/components/ui/icon";
import { ProjectTile } from "@/components/ui/project-tile";
import { useProjects } from "@/data/queries";
import { ShelfMark } from "@/features/archive/ArchivedNotice";
import { useArchiveCatalog } from "@/features/archive/use-archive-catalog";
import { cn } from "@/lib/utils";
import { useDialogStore } from "@/state/dialog-store";

type Archived = ProjectShelfDTO["projects"][number];

/**
 * Every project, each a row that opens its settings: the listed ones as the index has them (under the project they
 * are in), then the archived ones as serve lists them (`project/shelf`), marked archived. A project archived on its
 * own inside another archived one sits under the one serve names to restore first (`shelf.restoreTarget`). A project
 * only hidden by an archived one above it is no row: it comes back with that one. Restoring is the project's settings'.
 */
export function ProjectsSettingsTab() {
  const { t } = useTranslation("panels");
  const projects = useProjects();
  const { shelf } = useArchiveCatalog();
  return <div data-projects-tab>
    <ul className="-mx-2 my-0 list-none p-0" data-projects-list>
      {projects.map((project) => <ProjectRow key={project.id} id={project.id} title={project.title} color={project.color} depth={project.depth} />)}
    </ul>
    <Loadable query={shelf} skeleton={<RegionSkeleton shape="rows" rows={2} />} unwrapped
      empty={projects.length ? null : <div data-projects-empty><Message tone="empty" title={t("archive.list.empty")} /></div>}>
      {(data) => {
        const rows = archivedRows(data.projects);
        if (!rows.length) return null;
        return <ul className="-mx-2 my-0 list-none p-0" data-archived-list>
          {rows.map(({ project, inside }) => <ProjectRow key={project.id} id={project.id} title={project.title} color={project.color}
            depth={inside ? 1 : 0} archived />)}
        </ul>;
      }}
    </Loadable>
  </div>;
}

/** The archived projects in order: each one restorable now, with those archived inside it right under it. */
function archivedRows(projects: Archived[]): { project: Archived; inside: boolean }[] {
  const archived = projects.filter((project) => project.lifecycle === "archived");
  const own = (project: Archived) => project.shelf.restoreTarget === null || project.shelf.restoreTarget.id === project.id;
  const rows = archived.filter(own).flatMap((project) => [{ project, inside: false },
    ...archived.filter((each) => !own(each) && each.shelf.restoreTarget?.id === project.id).map((each) => ({ project: each, inside: true }))]);
  const placed = new Set(rows.map(({ project }) => project.id));
  return [...rows, ...archived.filter((project) => !placed.has(project.id)).map((project) => ({ project, inside: true }))];
}

function ProjectRow({ id, title, color, depth, archived = false }: { id: string; title: string; color: string; depth: number; archived?: boolean }) {
  const openProject = useDialogStore((state) => state.openProject);
  return <li data-project-row={id}>
    <button type="button" onClick={() => openProject(id)} style={{ paddingInlineStart: `${0.5 + depth * 1.5}rem` }}
      className={cn("flex min-h-control-md w-full min-w-0 cursor-pointer items-center gap-3 rounded-sm py-2 pe-2 text-start text-ink hover:bg-hover",
        "focus-visible:outline-2 focus-visible:outline-muted")}>
      <ProjectTile name={title} color={color} size={24} />
      <span className="min-w-0 flex-1">
        <span dir="auto" className="text-base [overflow-wrap:anywhere]">{title}</span>
        <span className="ml-2 text-sm text-soft tabular-nums">{id}</span>
        {archived && <ShelfMark lifecycle="archived" className="ml-2" />}
      </span>
      {/* Each row opens a page of its own, with Back back to this list. */}
      <Icon name="right" aria-hidden className="size-4 flex-none text-soft" />
    </button>
  </li>;
}
