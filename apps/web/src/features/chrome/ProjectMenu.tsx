import { countUse } from '@/features/telemetry/count';
import type * as React from "react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Popup } from "@/components/ui/popup";
import { isComposingKey } from "@/components/ui/composing";
import { useAllProjectCounts, useProjects } from "@/data/queries";
import { useMarksTasks, useProjectMarks } from "@/data/project-marks";
import { ProjectTile } from "@/components/ui/project-tile";
import type { WorkspaceInfo } from "@/data/types";
import { useDialogStore } from "@/state/dialog-store";
import { useViewStore } from "@/state/view-store";
import { cn } from "@/lib/utils";
import { moveMenuFocus } from "./menu-move";

/** The name of what the list shows: the project in view, else every project (the only one's name while there is one). */
export function useViewName(): string | null {
  const { t } = useTranslation("chrome");
  const projects = useProjects();
  const project = useViewStore((state) => state.project);
  if (project !== null) return projects.find(({ id }) => id === project)?.title ?? project;
  return projects.length === 1 ? projects[0]!.title : t("projects.all");
}

/** A project's numbers as the index counts them over its tree, nested projects included. */
type ProjectCounts = WorkspaceInfo["projects"][number]["counts"];

const COUNT_MARKS = [["turn", "bg-turn", "text-turn"], ["running", "bg-working", "text-working"]] as const;

/**
 * The numbers that ask for the reader, in the list's colours: orange Your turn (the user's turns not held), blue Working;
 * none when zero.
 */
export function CountMarks({ counts, className }: { counts: ProjectCounts; className?: string }) {
  const { t } = useTranslation("tree");
  return <span className={cn("flex flex-none items-center gap-2.5 tabular-nums", className)}>
    {COUNT_MARKS.map(([group, mark, tone]) => counts[group] > 0 &&
      <span key={group} data-count={group} title={`${group === "turn" ? t("home.turn") : t("home.running")} ${counts[group]}`} className={cn("flex items-center gap-1", tone)}>
        <i aria-hidden="true" className={cn("size-2 rounded-xs", mark)} />{counts[group]}
      </span>)}
  </span>;
}

/** ⌘ on a Mac, Ctrl elsewhere: the shortcut the menu names. */
const commandKey = () => /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl+";

/** ⌘0 shows every project, ⌘1–⌘9 the first nine (as the menu lists them). */
export function useProjectShortcuts() {
  const projects = useProjects();
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (isComposingKey(event) || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || !/^[0-9]$/.test(event.key)) return;
      if (projects.length < 2 || useDialogStore.getState().dialog) return;
      const at = Number(event.key);
      if (at > projects.length) return;
      event.preventDefault();
      useViewStore.getState().setProject(at === 0 ? null : projects[at - 1]!.id);
    };
    document.addEventListener("keydown", onKey, { capture: true });
    return () => document.removeEventListener("keydown", onKey, { capture: true });
  }, [projects]);
}

/**
 * The header's name is the list's project filter: pressed, it lists every project Task, one nested in another
 * indented under it, each with the numbers that ask for the reader and its ⌘ key, and Create project at the end.
 * The list keeps its form; it shows only the chosen project's tasks, its nested projects' included. It is the only way
 * to choose, a phone's too: while one project is in view, an orange dot on the name says one outside it has
 * Your turn. Its last rows open the project dialog: Create project, and the settings of the project in view (while
 * every project is, Project settings, which asks which). In a folded bar the name opens the bar's menu instead
 * (`onOpen`, BarMenu), which holds these same rows (ProjectChoices); it then has no ▾.
 */
export function ProjectMenu({ className, onOpen }: { className?: string; onOpen?: () => void }) {
  const { t } = useTranslation("chrome");
  const name = useViewName();
  const projects = useProjects();
  const project = useViewStore((state) => state.project);
  const [open, setOpen] = useState(false);
  // Every project's numbers, as the index counts them once over every project (none is added up here).
  const all = useAllProjectCounts();
  // While one project is in view, Your turn outside its tree is a dot on the name; which and how many are in the menu.
  const elsewhere = project !== null && all.turn > (projects.find(({ id }) => id === project)?.counts.turn ?? 0);
  const trigger = useRef<HTMLButtonElement>(null);
  const marks = useProjectMarks();
  // The project in view, marked before its name when the list holds more than one project (it has projects nested in it).
  const marksTasks = useMarksTasks();
  const headMark = project !== null && marksTasks ? marks.get(project) : undefined;
  return <>
    <h1 className={cn("min-w-0", className)} title={name ?? undefined}>
      <button ref={trigger} type="button" data-project-trigger aria-haspopup={onOpen ? "dialog" : "menu"} aria-expanded={onOpen ? undefined : open}
        aria-description={elsewhere ? t("home.turn", { ns: "tree" }) : undefined}
        onClick={() => onOpen ? onOpen() : setOpen((value) => !value)}
        className="flex max-w-full min-w-0 items-center gap-1 rounded-sm text-left hover:bg-hover narrow:min-h-11">
        {headMark && <ProjectTile name={headMark.name} color={headMark.color} size={24} className="mr-2.5" />}
        <span className="relative flex min-w-0">
          <span dir="auto" className="min-w-0 truncate">{name}</span>
          {elsewhere && <i data-turn-elsewhere aria-hidden="true" className="absolute -end-2 -top-0.5 size-2.5 rounded-full bg-turn ring-2 ring-bg" />}
        </span>
        {!onOpen && <Icon name="down" className={cn("size-4 flex-none text-muted", elsewhere && "ml-2")} />}
      </button>
    </h1>
    {open && <Popup open onOpenChange={setOpen} label={t("projects.menu")} className="w-110 p-1" anchorRef={trigger}>
      <div role="menu" aria-label={t("projects.menu")} onKeyDown={moveMenuFocus}>
        <ProjectChoices onDone={() => setOpen(false)} focusBack={trigger} />
      </div>
    </Popup>}
  </>;
}

/**
 * The project menu's rows: every project, the numbers that ask for the reader, and Create project and the settings at
 * the end. The header's menu and any other place that chooses the project show these same rows.
 */
export function ProjectChoices({ onDone, focusBack }: { onDone: () => void; focusBack?: React.RefObject<HTMLElement | null> }) {
  const { t } = useTranslation("chrome");
  const name = useViewName();
  const projects = useProjects();
  const project = useViewStore((state) => state.project);
  const all = useAllProjectCounts();
  const key = commandKey();
  const choose = (next: string | null) => { onDone(); countUse('project.filter'); useViewStore.getState().setProject(next); };
  // Settings of every project, or of one: its row's words, what it opens and its name all follow this.
  const allProjects = project === null && projects.length > 1;
  const marks = useProjectMarks();
  const row = (value: string | null, label: ReactNode, count: ProjectCounts, shortcut: number, depth = 0, mark?: string) =>
    <Button key={value ?? ""} variant="ghost" role="menuitemradio" aria-checked={project === value} data-project-item={value ?? "all"}
      onClick={() => choose(value)}
      className={cn("h-9 w-full justify-start gap-2.5 px-2.5 font-normal", project === value && "bg-hover font-semibold")}>
      <span className="flex w-3.5 flex-none justify-center">{project === value && <Icon name="check" className="size-3.5" />}</span>
      {/* A project is always marked here: the menu shows projects themselves. */}
      <span dir="auto" className="flex min-w-0 flex-1 items-center gap-2 text-start" style={depth ? { paddingInlineStart: `${depth}em` } : undefined}>
        {mark && marks.get(mark) && <ProjectTile name={marks.get(mark)!.name} color={marks.get(mark)!.color} size={20} />}
        {label}
      </span>
      <CountMarks counts={count} className="text-sm" />
      {projects.length > 1 && shortcut <= 9 && <kbd className="w-8 flex-none text-right font-sans text-xs text-soft narrow:hidden">{key}{shortcut}</kbd>}
    </Button>;
  const action = (mark: string, icon: "plus" | "settings", label: React.ReactNode, open: () => void, name?: string) =>
    <Button variant="ghost" role="menuitem" aria-label={name} {...{ [`data-${mark}`]: "" }} onClick={() => {
        onDone();
        requestAnimationFrame(() => { focusBack?.current?.focus({ preventScroll: true }); open(); });
      }}
      className="h-9 w-full justify-start gap-2.5 px-2.5 font-normal text-muted">
      <Icon name={icon} className="size-3.5" /><span className="flex min-w-0">{label}</span>
    </Button>;
  return <>
    {projects.length > 1 && <div role="group" className="border-b border-line pb-1">
      {row(null, t("projects.all"), all, 0)}
    </div>}
    <div role="group" className={cn(projects.length > 1 && "pt-1")}>
      {/* The only project is every project: choosing it shows them all. */}
      {projects.map(({ id, title, counts, depth }, at) => row(projects.length > 1 ? id : null, <><span className="min-w-0 truncate">{title}</span><span data-project-id className="flex-none text-xs text-soft">{" "}{id}</span></>, counts, at + 1, depth, id))}
    </div>
    <div role="group" className="mt-1 border-t border-line pt-1">
      {/* A dialog gives the focus back to what had it: the header's name, not this row that goes with the menu. A
          phone's menu is a sheet that holds the focus until it has gone, so the dialog opens a frame later. */}
      {action("project-new", "plus", t("projects.new"), () => useDialogStore.getState().openProject())}
      {/* A long name is cut, never the words after it. */}
      {projects.length > 0 && action("project-settings", "settings", allProjects ? t("projects.settingsAll")
        : <><span dir="auto" className="min-w-0 truncate">{name}</span><span className="flex-none whitespace-pre">{t("projects.settingsOf")}</span></>,
        () => useDialogStore.getState().openProject(allProjects ? null : project ?? projects[0]!.id),
        allProjects ? undefined : t("projects.settings", { name }))}
    </div>
  </>;
}
