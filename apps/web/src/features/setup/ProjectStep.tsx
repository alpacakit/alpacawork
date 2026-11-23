import { useState } from "react";
import { FormProvider, useFormState, useWatch } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Message } from "@/components/ui/message";
import { ReadFailure } from "@/components/ui/loadable";
import { useWorkspaceInfo } from "@/data/queries";
import type { WorkspaceInfo } from "@/data/types";
import { problemText } from "@/features/forms/problem-text";
import { FormError } from "@/features/forms/server-form";
import { ProjectLocationRow, ProjectNameRow, ProjectPolicySection } from "@/features/panels/ProjectSettings";
import { SaveUnconfirmed } from "@/features/panels/SaveUnconfirmed";
import { useProjectSave, type Project } from "@/features/panels/use-project-save";
import { FailureLine, Loading, StepButtons } from "./parts";

/**
 * Step 4: the project setup made, with the rows its settings have for its name, its code location and its policy (the
 * rest stays in Settings). Finish saves what changed, records setup as finished and opens the page on the project.
 */
export function ProjectStep({ projectId, onBack, onFinish }: { projectId: string; onBack: () => void; onFinish: () => Promise<void> }) {
  const { t } = useTranslation("setup");
  const projects = useWorkspaceInfo(info => info.projects);
  const project = projects.find(each => each.id === projectId);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const finish = async (save?: () => Promise<boolean>) => {
    if (busy) return;
    setBusy(true); setFailure(null);
    try {
      if (save && !await save()) return;
      await onFinish();
    } catch (error) { setFailure(error); }
    finally { setBusy(false); }
  };
  const failed = failure ? <FailureLine text={t("project.failed")} detail={problemText(failure)} /> : null;
  // Archived or removed since setup made it: there is nothing to set here, and setup can still be finished.
  if (!project) return <div data-setup-panel="project">
    <Message tone="info" size="line" title={t("project.gone")} />
    <StepButtons back={{ onClick: onBack, disabled: busy }} failure={failed}>
      <Button data-setup-finish className="min-h-11 px-6 narrow:w-full" disabled={busy} onClick={() => void finish()}>{t("project.finish")}</Button>
    </StepButtons>
  </div>;
  return <ProjectForm project={project} projects={projects} busy={busy} failed={failed} onBack={onBack} onFinish={finish} />;
}

function ProjectForm({ project, projects, busy, failed, onBack, onFinish }: {
  project: Project; projects: WorkspaceInfo["projects"]; busy: boolean; failed: React.ReactNode;
  onBack: () => void; onFinish: (save?: () => Promise<boolean>) => Promise<void>;
}) {
  const { t } = useTranslation("setup");
  const { form, base, query, tasksSchema, busy: saving, unconfirmed, unproven, blocked, writeDisabled, reread } = useProjectSave(project);
  const { isDirty, isSubmitting } = useFormState({ control: form.control });
  const title = useWatch({ control: form.control, name: "title" }) ?? "";
  const failedRead = base === null ? [query, tasksSchema].find(read => read.isError) : undefined;
  if (failedRead) return <ReadFailure what={t("project.title")} error={failedRead.error} retry={() => void failedRead.refetch()} />;
  if (base === null) return <Loading />;
  const working = busy || saving || isSubmitting;
  return <FormProvider {...form}>
    <div data-setup-panel="project">
      {/* Settings' own rows, each stacked (its name, its hint, then the control): the panel is narrower than Settings. */}
      <fieldset disabled={working} className="m-0 -mt-3 min-w-0 border-0 p-0 [&_[data-slot=setting-row]]:grid-cols-1 [&_[data-slot=setting-row]]:gap-y-2 [&_[data-slot=setting-row]:first-child]:border-t-0 [&_#project-policy]:min-h-40">
        <ProjectNameRow />
        <ProjectLocationRow project={project} projects={projects} rootHint={path => t("project.cwdHint", { path })} />
        <div className="mt-8" />
        <ProjectPolicySection project={project} projects={projects} note={t("project.policyNote")} />
      </fieldset>
      <FormError form={form} onReread={unproven ? undefined : reread} rereadLabel={t("project.reread")} />
      {unconfirmed && <SaveUnconfirmed unproven={unproven} onReread={() => void reread()} />}
      <StepButtons back={{ onClick: onBack, disabled: working }} failure={failed}>
        <Button data-setup-finish className="min-h-11 px-6 narrow:w-full" disabled={working || !title.trim() || blocked || writeDisabled}
          onClick={() => void onFinish(isDirty ? form.save : undefined)}>{t("project.finish")}</Button>
      </StepButtons>
    </div>
  </FormProvider>;
}
