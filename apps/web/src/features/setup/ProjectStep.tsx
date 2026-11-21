import { useEffect, useRef, useState } from "react";
import { FormProvider, useFormState, useWatch } from "react-hook-form";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { titleSchema, type SkillName } from "@alpacawork/contract";
import { Button } from "@/components/ui/button";
import { Message } from "@/components/ui/message";
import { ReadFailure } from "@/components/ui/loadable";
import { useWorkspaceInfo } from "@/data/queries";
import { useSkills } from "@/data/skills";
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
export function ProjectStep({ projectId, active, onBack, onFinish }: { projectId: string; active: boolean; onBack: () => void; onFinish: () => Promise<void> }) {
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
  return <ProjectForm project={project} projects={projects} active={active} busy={busy} failed={failed} onBack={onBack} onFinish={finish} />;
}

function ProjectForm({ project, projects, active, busy, failed, onBack, onFinish }: {
  project: Project; projects: WorkspaceInfo["projects"]; active: boolean; busy: boolean; failed: React.ReactNode;
  onBack: () => void; onFinish: (save?: () => Promise<boolean>) => Promise<void>;
}) {
  const { t, i18n } = useTranslation("setup");
  const { form, base, query, tasksSchema, busy: saving, unconfirmed, unproven, blocked, writeDisabled, reread } = useProjectSave(project);
  const { isDirty, isSubmitting } = useFormState({ control: form.control });
  const title = useWatch({ control: form.control, name: "title" }) ?? "";
  const skills = useSkills();
  // The recommended policy goes in when the project has none, and follows the skills installed and the display language
  // for as long as it is what was put in (going back to install another adds its line); once the person changes it,
  // emptied included, it is theirs.
  const offered = useRef<string | null>(null);
  const installed = skills.data?.skills.filter(skill => skill.installed).map(skill => skill.name);
  useEffect(() => {
    if (!active || base === null || !installed) return;
    const now = form.getValues("policy") ?? "";
    if (offered.current === null ? now.trim() !== "" : now !== offered.current) return;
    const next = recommendedPolicy(t, installed);
    offered.current = next;
    if (now !== next) form.setValue("policy", next, { shouldDirty: true });
  }, [active, base, installed?.join(), i18n.language]);
  // The name follows the working folder chosen (its last part) for as long as it is the name set up first or one put in
  // from a folder, and goes back to the first one when the folder is emptied; once the person writes a name, it is theirs.
  const cwd = useWatch({ control: form.control, name: "cwd" }) ?? "";
  const named = useRef<{ first: string; put: string } | null>(null);
  useEffect(() => {
    if (!active || base === null) return;
    const now = form.getValues("title") ?? "";
    named.current ??= { first: now, put: now };
    if (now !== named.current.put) return;
    const next = folderName(cwd) || named.current.first;
    named.current.put = next;
    if (now !== next) form.setValue("title", next, { shouldDirty: true });
  }, [active, base, cwd]);
  const failedRead = base === null ? [query, tasksSchema].find(read => read.isError) : undefined;
  if (failedRead) return <ReadFailure what={t("project.title")} error={failedRead.error} retry={() => void failedRead.refetch()} />;
  if (base === null) return <Loading />;
  const working = busy || saving || isSubmitting;
  return <FormProvider {...form}>
    <div data-setup-panel="project">
      {/* Settings' own rows, each stacked (its name, its hint, then the control): the panel is narrower than Settings. */}
      <fieldset disabled={working} className="m-0 -mt-3 min-w-0 border-0 p-0 [&_[data-slot=setting-row]]:grid-cols-1 [&_[data-slot=setting-row]]:gap-y-2 [&_[data-slot=setting-row]:first-child]:border-t-0 [&_#project-policy]:min-h-80">
        <ProjectNameRow />
        <ProjectLocationRow project={project} projects={projects} />
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

/**
 * A folder's own name, as the project's name: the last part of its path, whatever the separator; empty when that part
 * names no folder of its own (`~`, `.`, `..`, a drive) or is not a name a project takes (too long).
 */
const folderName = (path: string) => {
  const last = path.trim().replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
  return !/^(~|\.\.?|[A-Za-z]:)$/.test(last) && titleSchema.safeParse(last).success ? last : "";
};

/** The recommended rules, then one line per installed skill: when it is used, in the display language. */
function recommendedPolicy(t: TFunction<"setup">, installed: readonly SkillName[]): string {
  const lines = installed.map(name => t("project.policySkillLine", { skill: name, when: t(`skills.items.${name}.when`) }));
  // The skills go in a section of their own after the rules, set off by a blank line like the rules' own sections.
  return [t("project.policyStart"), ...lines.length ? ["", t("project.policySkills"), ...lines] : []].join("\n");
}
