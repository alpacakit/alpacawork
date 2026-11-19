import { useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { projectColorSchema, taskCreateShape } from "@alpacawork/contract";
import type { ProjectedIndexDTO } from "@alpacawork/contract/control";
import { FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { workspaceWriteBasis } from "@/data/connection";
import { admitDirectIntent, checkDirectIntent } from "@/data/direct-write";
import { useProjects, useWorkspaceInfo } from "@/data/queries";
import { queryClient } from "@/data/query-client";
import { indexKey } from "@/data/resources";
import { intentKey, useWriteIntent } from "@/data/write-intent";
import { newProjectColor } from "@/domain/project-mark";
import { acceptFormWrite, navigateWhen } from "@/features/forms/accept-write";
import { captureFormDraft, useStoredDraft } from "@/features/forms/draft-store";
import { FolderInput } from "@/features/forms/FolderInput";
import { FormDialog } from "@/features/forms/FormDialog";
import { formProblemText } from "@/features/forms/problem-text";
import { ProjectColorField } from "@/features/forms/ProjectColorField";
import { FormField, useServerForm } from "@/features/forms/server-form";
import { useDialogStore } from "@/state/dialog-store";
import { useViewStore } from "@/state/view-store";
import { ProjectOptions } from "./ProjectOptions";

/** The parent of a project at the top. */
const TOP = "none";

/** The dialog's fields as its draft keeps them: the name is the project Task's title. */
const projectInput = z.object({ name: taskCreateShape.shape.title, color: projectColorSchema, cwd: taskCreateShape.shape.cwd,
  parent: taskCreateShape.shape.parent.unwrap() });
type ProjectInput = z.infer<typeof projectInput>;

/**
 * Create project: a project Task, by its name, its colour, the project it is in (the one the list shows, at first; or
 * none, at the top), and the folder of its code on this PC, where its agents start (left empty, they start where its
 * parent's do). Made, the list shows the project; its values and fields are set in its settings.
 */
export function CreateProject() {
  const { t } = useTranslation("panels");
  const root = useWorkspaceInfo((info) => info.root);
  const projects = useProjects();
  const opening = useRef(useDialogStore.getState().dialog);
  const shown = useViewStore.getState().project ?? TOP;
  // A new project starts with the often-used colour farthest from those the projects have.
  const fresh = useMemo(() => newProjectColor(projects.map(({ color }) => color)), [projects]);
  const stored = useStoredDraft("project", null, () => ({ values: { name: "", color: fresh, cwd: "", parent: shown } }));
  // A parent kept from an earlier opening that is no longer listed gives way to the one shown.
  const kept = stored.entry.values.parent;
  const writeKey = intentKey(root, "project/new", null);
  const form = useServerForm<ProjectInput>({ schema: projectInput, rereadBlocks: false,
    defaultValues: { ...stored.entry.values, color: stored.entry.values.color ?? fresh,
      parent: kept === TOP || projects.some(({ id }) => id === kept) ? kept : shown },
    submit: async ({ name, color, cwd, parent }) => {
      const captured = captureFormDraft(stored.key);
      return acceptFormWrite(admitDirectIntent(queryClient, writeKey, { path: "task/new", response: "task", label: name, outcomes: 'all' },
        () => ({ kind: "project", parent, title: name.trim(), color, cwd: cwd || undefined }), workspaceWriteBasis(), captured),
        () => { if (useDialogStore.getState().dialog === opening.current) useDialogStore.getState().close(); }, ({ task }, mayChangeView) => {
      if (!mayChangeView) return;
      // The list narrows to it once the index lists it (the URL keeps only a project the index has).
      navigateWhen(() => !!queryClient.getQueryData<ProjectedIndexDTO>(indexKey)?.projects.some((each) => each.id === task.id),
        () => useViewStore.getState().setProject(task.id));
      });
    } });
  const intent = useWriteIntent<ProjectInput, unknown>(writeKey);
  const { watch } = form;
  useEffect(() => {
    const { unsubscribe } = watch((values, { name: field }) => {
      if (field) stored.change(field, values[field] ?? "");
    });
    return unsubscribe;
  }, [watch, stored.key]);
  useEffect(() => {
    form.clearFailure();
  }, [intent.status]);
  const failure = intent.failure && formProblemText(intent.failure);
  // Its folder list opens below the field: the dialog keeps its top and grows down, so what you pressed stays put.
  return <FormDialog title={t("project.title")} description={t("project.description")} className="mt-[8dvh] mb-auto max-h-[calc(92dvh-28px)] narrow:mt-3 narrow:h-[calc(100dvh-24px)] narrow:max-h-[calc(100dvh-24px)]"
    submitLabel={t("project.create")} pendingLabel={t("project.creating")} form={form}
    disabled={stored.unavailable || intent.unavailable || intent.status === "pending" || intent.status === "unconfirmed"}
    fieldsDisabled={intent.status === "pending"}
    checkMessage={t("forms:writeFailure.operationUnconfirmed")}
    checkRequired={intent.status === "unconfirmed"} checking={writeKey} rereadLabel={t("reader:recovery.check")}
    onReread={async () => { await checkDirectIntent(queryClient, writeKey); form.clearFailure(); }}>
    {failure && intent.status !== 'pending' && intent.status !== 'unconfirmed' && <FieldError>{failure}</FieldError>}
    {(stored.unavailable || intent.unavailable) && <FieldError>{t("forms:draft.storageUnavailable")}</FieldError>}
    <FormField form={form} name="name" id="project-new-name" label={t("project.name")}>
      {(field) => <Input {...field} autoComplete="off" dir="auto" placeholder={t("project.namePlaceholder")} />}
    </FormField>
    <FormField form={form} name="color" id="project-new-color" label={t("project.color")}>
      {(field) => <ProjectColorField id={field.id} labelledBy={`${field.id}-label`} name={form.watch("name")} value={field.value} onChange={field.onChange} />}
    </FormField>
    <FormField form={form} name="parent" id="project-parent" label={t("project.parent")}>
      {(field) => <NativeSelect variant="field" {...field}>
        <option value={TOP}>{t("forms:moveForm.top")}</option>
        <ProjectOptions projects={projects} />
      </NativeSelect>}
    </FormField>
    <FormField form={form} name="cwd" id="project-cwd" label={t("project.cwd")} optional
      hint={<>{t("project.cwdHint")} <code className="font-mono [overflow-wrap:anywhere]">{root}</code></>}>
      {(field) => <FolderInput {...field} value={field.value ?? ""} />}
    </FormField>
  </FormDialog>;
}
