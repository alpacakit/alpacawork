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
import { useGuide } from "@/features/guide/use-guide";

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
  const project = useWorkspaceInfo((info) => info.projects.find((item) => item.id === projectId) ?? null);
  // Each example's row names it and, under that, what the person will see once it is sent; it puts the words to send
  // in the input. They are written out for the extractor, which cannot read a key built from a name.
  const folder = project?.cwd ?? null;
  const examples = [
    ...folder ? [{ name: "folder", label: t("welcome.examples.folder.label"), shows: t("welcome.examples.folder.shows"), words: t("welcome.examples.folder.words", { path: folder }) }] : [],
    { name: "models", label: t("welcome.examples.models.label"), shows: t("welcome.examples.models.shows"), words: t("welcome.examples.models.words") },
    { name: "decide", label: t("welcome.examples.decide.label"), shows: t("welcome.examples.decide.shows"), words: t("welcome.examples.decide.words") },
    { name: "settings", label: t("welcome.examples.settings.label"), shows: t("welcome.examples.settings.shows"), words: t("welcome.examples.settings.words") },
  ];
  const step = useGuide(0);
  // One column in the middle: the heading and its one line, centred, then the examples, whose rows
  // read from their left edge; it rises into place in three parts, each a little
  // after the one above, every time it is put on the screen (motion.css, animate-welcome).
  // The guide's steps make the column taller by about their own height, so with them it starts that much higher.
  return <section data-welcome className={cn("flex justify-center px-5", step
    ? "pt-[clamp(16px,calc(40dvh-344px),160px)] narrow:pt-[clamp(12px,calc(100dvh-820px),96px)]"
    : "pt-[clamp(24px,calc(40dvh-228px),160px)] narrow:pt-[clamp(20px,calc(100dvh-672px),96px)]")}>
    <div className="w-[min(100%,36rem)] text-ink">
      <h2 className="m-0 animate-welcome text-center text-balance text-display font-semibold [word-break:auto-phrase]">{t("welcome.title")}</h2>
      <p className="mx-auto mt-3 mb-0 max-w-md animate-welcome text-center text-balance text-md text-muted [word-break:auto-phrase] [animation-delay:calc(var(--motion-fast)/2)] motion-reduce:[animation-delay:0s]">{t("welcome.lead")}</p>
      <div className={cn("animate-welcome [animation-delay:var(--motion-fast)] motion-reduce:[animation-delay:0s]", step ? "mt-0" : "mt-8 narrow:mt-6")}>
        {step && <GuideSteps step={step} />}
        <div className={step ? "mt-3" : undefined}>
          <ExampleList examples={examples} mark="data-welcome-example" roomy={!step}
            onPick={words => exampleInDraft(words, project && { id: project.id, title: project.title })} />
        </div>
        <WorkingFolder folder={folder} project={projectId} />
        <AppHint />
      </div>
    </div>
  </section>;
}

/**
 * Under the examples, where agents of this project work: its own working folder, said quietly; or, with none chosen,
 * that choosing a repository there is how it is used on the person's own code, with the way to the project's settings.
 */
function WorkingFolder({ folder, project }: { folder: string | null; project: string | null }) {
  const { t } = useTranslation("tree");
  if (folder) return <p data-welcome-folder className="m-0 mt-2 text-center text-sm text-soft [overflow-wrap:anywhere]">{t("welcome.folder.at", { path: folder })}</p>;
  return <p data-welcome-folder="" className="m-0 mt-2 text-center text-sm text-pretty text-soft [word-break:auto-phrase]">
    {t("welcome.folder.none")}{" "}
    <Button variant="ref" onClick={() => useDialogStore.getState().openProject(project)}>{t("welcome.folder.choose")}</Button>
  </p>;
}
