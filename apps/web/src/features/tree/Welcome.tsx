import { useTranslation } from "react-i18next";
import { ExampleList } from "@/components/ui/example-list";
import { useWorkspaceInfo } from "@/data/queries";
import { useViewStore } from "@/state/view-store";
import { exampleInDraft } from "@/features/coordinator/editor/draft";
import { AppHint } from "@/features/coordinator/app-hint";

/**
 * The list's place while the scope in view holds no Task at all (counts.tasks; live, finished or shelved): a welcome
 * and how work starts, with examples that show agents working together on a surface of their own (ExampleList), in one
 * column a little above the middle of the list's place (by the screen's height alone, so it never moves when the input
 * at the foot grows), clear of that input. An example only goes into the input; the person sends it. Under the examples,
 * the first time, the line to the phone and app guide (AppHint): this is the first screen a new person sees.
 */
export function Welcome() {
  const { t } = useTranslation("tree");
  const projectId = useViewStore((state) => state.project);
  const project = useWorkspaceInfo((info) => info.projects.find((item) => item.id === projectId) ?? null);
  // Each example's row names it and, under that, what the person will see once it is sent; it puts the words to send
  // in the input. They are written out for the extractor, which cannot read a key built from a name.
  const examples = [
    { name: "models", label: t("welcome.examples.models.label"), shows: t("welcome.examples.models.shows"), words: t("welcome.examples.models.words") },
    { name: "decide", label: t("welcome.examples.decide.label"), shows: t("welcome.examples.decide.shows"), words: t("welcome.examples.decide.words") },
    { name: "settings", label: t("welcome.examples.settings.label"), shows: t("welcome.examples.settings.shows"), words: t("welcome.examples.settings.words") },
  ];
  // One column in the middle: the heading and one short line inviting a try, centred, then the examples, whose rows
  // read from their left edge; it rises into place in three parts, each a little
  // after the one above, every time it is put on the screen (motion.css, animate-welcome).
  return <section data-welcome className="flex justify-center px-5 pt-[clamp(24px,calc(40dvh-228px),160px)] narrow:pt-[clamp(20px,calc(100dvh-672px),96px)]">
    <div className="w-[min(100%,36rem)] text-ink">
      <h2 className="m-0 animate-welcome text-center text-balance text-display font-semibold [word-break:auto-phrase]">{t("welcome.title")}</h2>
      <p className="mx-auto mt-3 mb-0 max-w-md animate-welcome text-center text-balance text-md text-muted [word-break:auto-phrase] [animation-delay:calc(var(--motion-fast)/2)] motion-reduce:[animation-delay:0s]">{t("welcome.lead")}</p>
      <div className="mt-8 animate-welcome [animation-delay:var(--motion-fast)] motion-reduce:[animation-delay:0s] narrow:mt-6">
        <ExampleList examples={examples} mark="data-welcome-example" roomy
          onPick={words => exampleInDraft(words, project && { id: project.id, title: project.title })} />
        <AppHint />
      </div>
    </div>
  </section>;
}
