import { useEffect, useState } from "react";
import { FormProvider, useFormContext, useFormState, useWatch } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { SettingRow } from "@/components/settings/SettingRow";
import { SettingSection } from "@/components/settings/SettingSection";
import { Button } from "@/components/ui/button";
import { Caret, DisclosureSummary } from "@/components/ui/caret";
import { DialogFooter } from "@/components/ui/dialog";
import { FieldHint } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Message } from "@/components/ui/message";
import { ReadFailure } from "@/components/ui/loadable";
import { RegionSkeleton } from "@/components/ui/skeleton";
import { DEFAULT_SCHEMA } from "@alpacawork/contract";
import { useFieldCatalog, useTaskSchema } from "@/data/fields";
import { useEveryTaskIndex, useTaskDetail, useWorkspaceInfo } from "@/data/queries";
import type { WorkspaceInfo } from "@/data/types";
import { Textarea } from "@/components/ui/textarea";
import { ProjectArchiveSection } from "@/features/archive/ProjectArchiveSection";
import { FolderInput } from "@/features/forms/FolderInput";
import { ProjectColorField } from "@/features/forms/ProjectColorField";
import { FormError, SubmitButton } from "@/features/forms/server-form";
import { SaveUnconfirmed } from "./SaveUnconfirmed";
import { SchemaFields } from "./SchemaFields";
import { PROJECT_POLICY } from "@alpacawork/contract";
import type { ProjectDraft } from "./settings-draft";
import { useProjectSave, type Project } from "./use-project-save";

/**
 * The fields, in the order they are read: name, colour, the project it is in (shown, not changed here), code location,
 * its values (field by field, with what the projects above it pass on folded under them), the fields its Tasks use;
 * then the save bar at
 * the end of the content, and under a divider, Archive project. What a save writes is `useProjectSave`'s.
 */
export function ProjectSettings({ project, projects, onUnsaved, onArchived }: { project: Project; projects: WorkspaceInfo["projects"]; onUnsaved: (unsaved: boolean) => void; onArchived: () => void }) {
  const { t } = useTranslation("panels");
  const { form, base, task, query, tasksSchema, busy, unconfirmed, unproven, blocked, writeDisabled, reread } = useProjectSave(project);
  const { fields: views, query: catalog } = useFieldCatalog();
  const above = useTaskSchema(project.parentId);
  const { isDirty, isSubmitting } = useFormState({ control: form.control });
  /** One reading of the form for the save bar and the archive section alike: changes not saved, and a save under way. */
  const dirty = isDirty, saving = isSubmitting || busy;
  const draft = useWatch({ control: form.control }) as ProjectDraft;
  useEffect(() => onUnsaved(dirty || saving), [dirty, saving, onUnsaved]);
  useEffect(() => () => onUnsaved(false), [onUnsaved]);
  // The draft waits for both reads: either failing is said with a retry, never left as the skeleton.
  const failed = base === null ? [query, tasksSchema].filter((read) => read.isError) : [];
  if (failed.length) return <ReadFailure what={t("settings.global.readError")} error={failed[0]!.error}
    retry={() => failed.forEach((read) => void read.refetch())} />;
  if (base === null || !task) return <RegionSkeleton shape="text" />;

  const parent = projects.find(({ id }) => id === project.parentId);
  const fields = draft.fields ?? [];
  // A project at the top inherits the app's default fields; one inside another, what that project uses.
  const inheritedFields = project.parentId === null ? [...DEFAULT_SCHEMA] : above.data?.fields;
  const inheritedFrom = project.parentId !== null && above.data?.from ? projects.find(({ id }) => id === above.data!.from)?.title ?? above.data.from : null;
  return <FormProvider {...form}>
    <div className="py-1" data-project-settings>
      {/* The fields hold still while a save is under way: what it answers is the base the next save starts from. */}
      <fieldset disabled={saving} data-project-fields className="m-0 min-w-0 border-0 p-0">
      <ProjectNameRow />
      <SettingRow id="project-color" label={t("project.color")} className="narrow:grid-cols-1 narrow:gap-y-2">
        <ProjectColorField id="project-color" labelledBy="project-color-label" name={draft.title ?? project.title} value={draft.color}
          onChange={(color) => form.setValue("color", color, { shouldDirty: true })} />
      </SettingRow>
      <SettingRow id="project-parent-shown" label={t("project.parent")}>
        <span id="project-parent-shown" className="text-muted">{parent ? t("project.named", { title: parent.title, id: parent.id }) : t("forms:moveForm.top")}</span>
      </SettingRow>
      <ProjectLocationRow project={project} projects={projects} />
      <div className="mt-8" />
      <ProjectPolicySection project={project} projects={projects} />
      <SettingSection id="project-fields" title={t("settings.tabs.fields")} note={t("project.fieldsNote")} spaced>
        {views ? <SchemaFields fields={fields} own={draft.ownFields ?? false} views={views} inheritedFrom={inheritedFrom}
          inherited={inheritedFields}
          onChange={(next, own) => { form.setValue("fields", next, { shouldDirty: true }); form.setValue("ownFields", own, { shouldDirty: true }); }} />
          : catalog.isError ? <ReadFailure error={catalog.error} retry={() => void catalog.refetch()} /> : <RegionSkeleton shape="text" />}
      </SettingSection>
      </fieldset>
      <FormError form={form} onReread={unproven ? undefined : reread} rereadLabel={t("settings.server.reload")} />
      {unconfirmed && <SaveUnconfirmed unproven={unproven} onReread={() => void reread()} />}
      {/* In the content's flow, last: on a phone a bar kept in view would cover the field being typed in. */}
      <DialogFooter data-project-save className="flex-wrap">
        <FieldHint role="status" className="min-w-0 flex-1 basis-40 narrow:basis-full">{dirty ? t("settings.status.dirty") : t("settings.status.saved")}</FieldHint>
        <Button variant="outline" disabled={!dirty || saving} onClick={() => form.reset()}>{t("settings.discard")}</Button>
        <SubmitButton form={form} disabled={!dirty || writeDisabled || saving || blocked}
          label={t("settings.server.save")} onClick={() => void form.save()} />
      </DialogFooter>
      <hr data-project-archive-divider className="mt-7 mb-5 border-0 border-t border-line" />
      <ProjectArchiveSection project={{ id: project.id, title: task.title, hash: task.hash }} dirty={dirty} saving={saving}
        onArchived={onArchived} />
    </div>
  </FormProvider>;
}

/** The project's name, as the settings and the setup's last step show it, in the form of `useProjectSave`. */
export function ProjectNameRow() {
  const { t } = useTranslation("panels");
  const { register, formState: { errors } } = useFormContext<ProjectDraft>();
  return <SettingRow id="project-name" label={t("project.name")} error={errors.title?.message}>
    <Input id="project-name" dir="auto" autoComplete="off" aria-invalid={!!errors.title} className="w-64 max-w-[50vw] min-w-0" {...register("title")} />
  </SettingRow>;
}

/** Where its agents start on this PC; empty, where the nearest project above names, else the workspace. */
export function ProjectLocationRow({ project, projects }: { project: Project; projects: WorkspaceInfo["projects"] }) {
  const { t } = useTranslation("panels");
  const root = useWorkspaceInfo((info) => info.root);
  const { control, setValue, formState: { errors } } = useFormContext<ProjectDraft>();
  const cwd = useWatch({ control, name: "cwd" });
  const inherited = inheritedLocation(projects, project);
  return <SettingRow id="project-location" label={t("project.cwd")} className="narrow:grid-cols-1 narrow:gap-y-2"
    hint={inherited ? t("project.locationInherits", { path: inherited }) : t("project.locationRoot", { path: root })} error={errors.cwd?.message}>
    <div className="w-110 max-w-full min-w-0 narrow:w-full">
      <FolderInput id="project-location" value={cwd} onChange={(value) => setValue("cwd", value, { shouldDirty: true })} />
    </div>
  </SettingRow>;
}

/** One free text: what to write is the person's own; the example only suggests what helps (purpose, policy, what not to do). */
export function ProjectPolicySection({ project, projects, note }: { project: Project; projects: WorkspaceInfo["projects"];
  /** Where it is read before the project has any inside it (setup), a note that names only this project's agents. */
  note?: string }) {
  const { t } = useTranslation("panels");
  const { control, register } = useFormContext<ProjectDraft>();
  const policy = useWatch({ control, name: "policy" }) ?? "";
  return <SettingSection id="project-policy-heading" title={t("project.policy")} note={note ?? t("project.policyNote")} spaced>
    {/* Shown, not behind a hover, so a phone gets it too; the detail is an element so it starts its own line under the title. */}
    <Message data-policy-vs-agents-md tone="info" size="band" title={t("project.policyVsAgentsMd.title")}
      description={<>{t("project.policyVsAgentsMd.detail")}</>} />
    <Textarea id="project-policy" dir="auto" aria-labelledby="project-policy-heading" aria-describedby="project-policy-count"
      placeholder={t("project.policyExample")} className="min-h-56 whitespace-pre-wrap" {...register("policy")} />
    <FieldHint id="project-policy-count" className="mt-0 text-end tabular-nums">{t("project.policyCount", { count: [...policy].length })}</FieldHint>
    <InheritedLines project={project} projects={projects} />
  </SettingSection>;
}

/** The projects above this one, nearest first. */
function ancestorsOf(projects: WorkspaceInfo["projects"], project: Project): Project[] {
  const above: Project[] = [];
  for (let at = projects.find(({ id }) => id === project.parentId); at; at = projects.find(({ id }) => id === at!.parentId)) above.push(at);
  return above;
}

/** Where a project's agents start when it names no folder: the nearest project above it that does. */
function inheritedLocation(projects: WorkspaceInfo["projects"], project: Project): string | null {
  return ancestorsOf(projects, project).find(({ cwd }) => cwd)?.cwd ?? null;
}

/** What the projects above this one pass on to its agents (each one's context, as the policy chain carries it), folded. */
function InheritedLines({ project, projects }: { project: Project; projects: WorkspaceInfo["projects"] }) {
  const { t } = useTranslation("panels");
  const [open, setOpen] = useState(false);
  const above = ancestorsOf(projects, project).reverse();
  // A project at the top is passed nothing.
  if (!above.length) return null;
  return <details className="mt-2 text-sm" open={open} onToggle={(event) => setOpen(event.currentTarget.open)} data-project-inherited>
    <DisclosureSummary className="gap-1.5 text-muted"><Caret open={open} />{t("project.inherited")}</DisclosureSummary>
    {open && above.map((each) => <AncestorContext key={each.id} project={each} />)}
  </details>;
}

/** The policy one project above passes on, as its agents are given it. */
function AncestorContext({ project }: { project: Project }) {
  const task = useEveryTaskIndex().byId.get(project.id);
  const { detail, query } = useTaskDetail(task);
  if (!detail) return query.isError ? <ReadFailure error={query.error} className="mt-2" retry={() => void query.refetch()} /> : <RegionSkeleton shape="text" />;
  return <div className="mt-2" data-project-inherited-from={project.id}>
    <p className="m-0 font-semibold">{project.title}<span className="ml-2 font-normal text-soft tabular-nums">{project.id}</span></p>
    <p dir="auto" className="m-0 mt-1 whitespace-pre-wrap text-muted [overflow-wrap:anywhere]">{String(detail.values.values[PROJECT_POLICY] ?? "")}</p>
  </div>;
}
