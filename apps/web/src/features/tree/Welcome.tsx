import { useState } from "react";
import { useFormState, useWatch } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { ExampleList } from "@/components/ui/example-list";
import { useWorkspaceInfo } from "@/data/queries";
import { useViewStore } from "@/state/view-store";
import { exampleInDraft } from "@/features/coordinator/editor/draft";
import { AppHint } from "@/features/coordinator/app-hint";
import { useDialogStore } from "@/state/dialog-store";
import { Button } from "@/components/ui/button";
import { GuideSteps } from "@/features/guide/Guide";
import { useGoingGuide } from "@/features/guide/use-guide";
import { FieldError } from "@/components/ui/field";
import { FolderInput } from "@/features/forms/FolderInput";
import { FormError, SubmitButton } from "@/features/forms/server-form";
import { useProjectSave, type Project } from "@/features/panels/use-project-save";

/**
 * The list's place while the scope in view holds no Task at all (counts.tasks; live, finished or shelved): a welcome
 * and one line on how the work goes, the getting-started guide's steps while this browser is in it (GuideSteps), and
 * examples that show agents working together on a surface of their own (ExampleList), in one column a little above the
 * middle of the list's place (by the screen's height alone, so it never moves when the input at the foot grows), clear
 * of that input. With a working folder of its own, the project's first example reads that folder. An example only goes
 * into the input; the person sends it. Under the examples, where the project's agents work, then, the first time, the
 * line to the phone and app guide (AppHint): this is the first screen a new person sees.
 */
export function Welcome() {
  const { t } = useTranslation("tree");
  const projectId = useViewStore((state) => state.project);
  // The project in view; with every project in view and only one there is (a new person's), that one.
  const project = useWorkspaceInfo((info) => info.projects.find((item) => item.id === projectId)
    ?? (projectId === null && info.projects.length === 1 ? info.projects[0]! : null));
  // Each example's row names it and, under that, what the person will see once it is sent; it puts the words to send
  // in the input. They are written out for the extractor, which cannot read a key built from a name.
  const folder = project?.cwd ?? null;
  const examples = [
    ...folder ? [{ name: "folder", label: t("welcome.examples.folder.label"), shows: t("welcome.examples.folder.shows"), words: t("welcome.examples.folder.words", { path: folder }) }] : [],
    { name: "models", label: t("welcome.examples.models.label"), shows: t("welcome.examples.models.shows"), words: t("welcome.examples.models.words") },
    { name: "decide", label: t("welcome.examples.decide.label"), shows: t("welcome.examples.decide.shows"), words: t("welcome.examples.decide.words") },
    { name: "settings", label: t("welcome.examples.settings.label"), shows: t("welcome.examples.settings.shows"), words: t("welcome.examples.settings.words") },
  ];
  const step = useGoingGuide();
  // One column in the middle: the heading and its one line, centred, then the examples, whose rows
  // read from their left edge; it rises into place in three parts, each a little
  // after the one above, every time it is put on the screen (motion.css, animate-welcome).
  // The guide's steps make the column taller by about their own height, so with them it starts that much higher.
  return <section data-welcome className={cn("flex justify-center px-5", step
    // and keeps room under it for the guide's balloon over the input, so the last example can be scrolled clear of it.
    ? "pt-[clamp(16px,calc(40dvh-344px),160px)] pb-6 narrow:pt-[clamp(12px,calc(100dvh-820px),96px)] narrow:pb-32"
    : "pt-[clamp(24px,calc(40dvh-228px),160px)] narrow:pt-[clamp(20px,calc(100dvh-672px),96px)]")}>
    <div className="w-[min(100%,36rem)] text-ink">
      <h2 className="m-0 animate-welcome text-center text-balance text-display font-semibold [word-break:auto-phrase]">{t("welcome.title")}</h2>
      <p className="mx-auto mt-3 mb-0 max-w-md animate-welcome text-center text-balance text-md text-muted [word-break:auto-phrase] [animation-delay:calc(var(--motion-fast)/2)] motion-reduce:[animation-delay:0s]">{t("welcome.lead", { section: t("home.turn") })}</p>
      <div className={cn("animate-welcome [animation-delay:var(--motion-fast)] motion-reduce:[animation-delay:0s]", step ? "mt-0" : "mt-8 narrow:mt-6")}>
        {step && <GuideSteps stage={step} />}
        <div className={step ? "mt-3" : undefined}>
          <ExampleList examples={examples} mark="data-welcome-example" roomy={!step}
            onPick={words => exampleInDraft(words, project && { id: project.id, title: project.title })} />
        </div>
        {/* Each project its own: a field opened, and what was written in it, stay with the project it was for. */}
        <WorkingFolder key={project?.id ?? ""} folder={folder} project={project} />
        {/* The phone and app guide waits until the getting-started guide is over or closed. */}
        {!step && <AppHint />}
      </div>
    </div>
  </section>;
}

/**
 * Under the examples, where the project's AI works: its own working folder, said quietly; or, with none chosen, that
 * choosing a repository there is how it is used on the person's own code. Pressed, that way opens the folder field and
 * its save in place (the project's own save, as its settings make it), so a folder chosen here is saved here; once saved,
 * the line says the folder and the folder's example comes first. With every project in view it asks which in settings.
 */
function WorkingFolder({ folder, project }: { folder: string | null; project: Project | null }) {
  const { t } = useTranslation("tree");
  const [choosing, setChoosing] = useState(false);
  if (folder) return <p data-welcome-folder="set" className="m-0 mt-2 text-center text-sm text-soft [overflow-wrap:anywhere]">{t("welcome.folder.at", { path: folder })}</p>;
  if (choosing && project) return <ChooseFolder project={project} />;
  return <p data-welcome-folder="none" className="m-0 mt-2 text-center text-sm text-pretty text-soft [word-break:auto-phrase]">
    {t("welcome.folder.none")}{" "}
    <Button variant="ref" onClick={() => project ? setChoosing(true) : useDialogStore.getState().openProject(null)}>{t("welcome.folder.choose")}</Button>
  </p>;
}

/** The project's working folder field and its save, alone: the folder as the project's settings save it. */
function ChooseFolder({ project }: { project: Project }) {
  const { t } = useTranslation("tree");
  const { t: pt } = useTranslation("panels");
  const { form, base, busy, writeDisabled, unproven, reread } = useProjectSave(project);
  const cwd = useWatch({ control: form.control, name: "cwd" }) ?? "";
  // Why the folder was not taken (not there, say), under the field, as the project's settings say it.
  const { errors } = useFormState({ control: form.control, name: "cwd" });
  const error = errors.cwd?.message;
  return <form data-welcome-folder="choose" className="mt-2" onSubmit={event => { event.preventDefault(); void form.save(); }}>
    <label htmlFor="welcome-folder" className="block text-center text-sm text-pretty text-soft [word-break:auto-phrase]">{t("welcome.folder.ask")}</label>
    <div className="mt-1.5 flex items-start gap-2">
      <FolderInput id="welcome-folder" className="min-w-0 flex-1" value={cwd} disabled={base === null}
        aria-invalid={error ? true : undefined} aria-describedby={error ? "welcome-folder-error" : undefined}
        onChange={value => form.setValue("cwd", value, { shouldDirty: true })} />
      <SubmitButton form={form} className="self-stretch px-4" label={pt("settings.server.save")} disabled={base === null || busy || writeDisabled || !cwd.trim()} />
    </div>
    {error && <FieldError id="welcome-folder-error" className="mt-type-close">{error}</FieldError>}
    <FormError form={form} onReread={unproven ? undefined : reread} rereadLabel={pt("settings.server.reload")} />
  </form>;
}
