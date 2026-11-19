import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { SettingRow } from "@/components/settings/SettingRow";
import { CopyButton } from "@/components/ui/copy-button";
import { Dialog, DialogBody, DialogContent, DialogHeading } from "@/components/ui/dialog";
import { FieldHint } from "@/components/ui/field";
import { NativeSelect } from "@/components/ui/native-select";
import { Button } from "@/components/ui/button";
import { Loadable, ReadFailure } from "@/components/ui/loadable";
import { ProjectTile } from "@/components/ui/project-tile";
import { RegionSkeleton } from "@/components/ui/skeleton";
import { useProjects, useWorkspaceInfo } from "@/data/queries";
import { watchNewWriteConfirmation } from "@/data/write-intent";
import { projectArchiveIntentKey } from "@/features/archive/archive-operations";
import { useArchiveCatalog } from "@/features/archive/use-archive-catalog";
import { afterSave } from "@/features/forms/drafts";
import { textClip } from "@/lib/clipboard";
import { useDialogBack, useDialogStore } from "@/state/dialog-store";
import { CreateProject } from "./CreateProject";
import { ProjectOptions } from "./ProjectOptions";
import { ProjectSettings } from "./ProjectSettings";
import type { Project } from "./use-project-save";

/**
 * A project's settings, the one dialog it is made and changed in (the header's project menu): Create project when no
 * `project` is given, else that project's settings (`null`: every project is shown, and the dialog asks which).
 */
export function ProjectDialog({ project }: { project?: string | null }) {
  const opening = useDialogStore(state => state.dialog);
  const [lifetime, setLifetime] = useState({ opening, serial: 0 });
  // openProject can replace the opening without changing DialogHost's project key.
  if (lifetime.opening !== opening) setLifetime({ opening, serial: lifetime.serial + 1 });
  return project === undefined ? <CreateProject /> : <EditProject key={`${lifetime.serial}:${project ?? 'all'}`} initial={project} />;
}

/**
 * One project's settings. While every project is shown it asks which first, by title and ID, and moves to another
 * only with nothing unsaved; each project is a draft of its own, read afresh.
 */
function EditProject({ initial }: { initial: string | null }) {
  const { t } = useTranslation("panels");
  const close = useDialogStore((state) => state.close);
  const back = useDialogBack();
  const projects = useProjects();
  const root = useWorkspaceInfo(info => info.root);
  const [chosen, setChosen] = useState(() => initial ?? projects[0]?.id ?? null);
  const [unsaved, setUnsaved] = useState(false);
  // Choose once when the first list arrives; losing that ID never selects another project's draft.
  if (chosen === null && projects[0]) setChosen(projects[0].id);
  const project = projects.find(({ id }) => id === chosen);
  // Archived, the dialog is done: it goes back to what it was opened from (Settings' Projects, the project now marked
  // there), or closes when it was opened on its own.
  const leave = useDialogStore((state) => state.back);
  const completion = useRef<ReturnType<typeof watchNewWriteConfirmation> | undefined>(undefined);
  useEffect(() => {
    if (chosen === null) return;
    const followed = watchNewWriteConfirmation(projectArchiveIntentKey(root, chosen), afterSave(leave));
    completion.current = followed;
    return () => { followed.stop(); completion.current = undefined; };
  }, [root, chosen, leave]);
  const onArchived = () => completion.current?.check();
  // A project not listed is looked up among the archived ones: its settings come back once it is restored.
  if (!project && chosen !== null) return <Dialog open onOpenChange={(open) => !open && close()}>
    <DialogContent size="large" aria-describedby={undefined}><ShelvedProject id={chosen} /></DialogContent>
  </Dialog>;
  return <Dialog open onOpenChange={(open) => !open && close()}>
    <DialogContent size="large" aria-describedby={undefined}>
      <DialogHeading title={project ? <ProjectHeading project={project} /> : t("project.settingsTitle")} back={back} />
      <DialogBody>
        {initial === null && projects.length > 1 && <SettingRow id="project-settings-target" label={t("project.target")} className="mb-4"
          hint={unsaved ? t("project.targetHeld") : undefined}>
          <NativeSelect id="project-settings-target" value={chosen ?? ''} disabled={unsaved} onChange={(event) => setChosen(event.target.value)}
            className="w-64 max-w-[50vw] min-w-0">
            <ProjectOptions projects={projects} />
          </NativeSelect>
        </SettingRow>}
        {project ? <ProjectSettings key={project.id} project={project} projects={projects} onUnsaved={setUnsaved} onArchived={onArchived} />
          : <FieldHint role="status">{t("project.gone")}</FieldHint>}
      </DialogBody>
    </DialogContent>
  </Dialog>;
}

/**
 * An archived project, as serve lists it (`project/shelf`): its name, then that it is archived and what brings it back,
 * laid out as the settings of a listed one end with Archive project (heading, what it does, its button). Restored, it
 * is listed again and the dialog shows its settings. One archived inside another names the one to restore first; one
 * inside a deleted project offers nothing.
 */
function ShelvedProject({ id }: { id: string }) {
  const { t } = useTranslation("panels");
  const back = useDialogBack();
  const { shelf, onRestore, restoring, restoreFailure, restoreDisabled } = useArchiveCatalog();
  const shelved = shelf.data?.projects.find((each) => each.id === id && each.lifecycle === "archived");
  return <>
    <DialogHeading title={shelved ? <ProjectHeading project={shelved} /> : t("project.settingsTitle")} back={back} />
    <DialogBody>
      <Loadable query={shelf} skeleton={<RegionSkeleton shape="text" />} empty={null}>
        {() => {
          if (!shelved) return <FieldHint role="status">{t("project.gone")}</FieldHint>;
          const target = shelved.shelf.restoreTarget, own = target?.id === shelved.id;
          if (target === null) return <FieldHint role="status" className="mt-0">{t("archive.list.insideDeleted")}</FieldHint>;
          return <section data-project-restore>
            <h3 className="m-0 text-base font-medium">{t("archive.restore.title")}</h3>
            <FieldHint className="[word-break:auto-phrase]">{own ? t("archive.restore.note") : t("archive.list.inside", { title: target.title })}</FieldHint>
            {own && <Button variant="outline" disabled={restoreDisabled || !!restoring} onClick={() => onRestore(target)}>
              {restoring === target.id ? t("archive.list.restoring") : t("archive.list.restore")}</Button>}
            {restoreFailure && restoreFailure.id === target.id && <ReadFailure error={restoreFailure.error} className="mt-2" />}
          </section>;
        }}
      </Loadable>
    </DialogBody>
  </>;
}

/** The dialog's title: the project's tile, its name and its ID with a copy mark. */
function ProjectHeading({ project }: { project: Pick<Project, "id" | "title" | "color"> }) {
  const { t } = useTranslation("panels");
  return <span className="flex min-w-0 items-center gap-2.5" data-project-heading>
    <ProjectTile name={project.title} color={project.color} size={28} />
    <span dir="auto" className="min-w-0 truncate">{project.title}</span>
    <span className="flex-none text-md font-normal text-soft tabular-nums">{project.id}</span>
    <CopyButton clip={() => textClip(project.id)} label={t("project.copyId", { id: project.id })} className="flex-none" />
  </span>;
}
