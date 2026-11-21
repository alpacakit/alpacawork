import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { useNarrow } from "@/state/view-store";
import { closeGuide, type GuideStep } from "./guide-step";

const STEPS = [1, 2, 3] as const;

/** The guide's close mark (×): it ends the guide on this browser; settings can show it again. */
function CloseGuide() {
  const { t } = useTranslation("tree");
  return <Button variant="quiet" size="icon" data-guide-close aria-label={t("guide.close")} title={t("guide.close")} onClick={closeGuide}
    className="flex-none narrow:size-11 narrow:min-h-11">
    <Icon name="close" className="size-4" />
  </Button>;
}

/**
 * On an empty scope's welcome, how using alpacawork goes, in three numbered steps (send a request, AI works on it,
 * your turn), the step the person is at stressed and the ones behind them checked. Once a request is sent and before its
 * Task is listed, the second step says the coordinator has it. On a phone only the current step keeps its line of
 * detail, so the examples under it stay on the first screen.
 */
export function GuideSteps({ step }: { step: GuideStep }) {
  const { t } = useTranslation("tree");
  const narrow = useNarrow();
  // Written out for the extractor, which cannot read a key built from a name.
  const said = {
    1: { title: t("guide.steps.send.title"), detail: t("guide.steps.send.detail") },
    2: { title: t("guide.steps.work.title"), detail: step.say === "received" ? t("guide.steps.work.received") : t("guide.steps.work.detail") },
    3: { title: t("guide.steps.turn.title"), detail: t("guide.steps.turn.detail") },
  };
  return <div data-guide-steps={step.step} className="relative mt-5 rounded-lg border-hairline border-rule px-4 pt-2 pb-2.5 narrow:mt-4 narrow:px-3">
    <p className="m-0 mb-1.5 text-xs font-medium text-muted">{t("guide.name")}</p>
    <div className="absolute top-1 right-1"><CloseGuide /></div>
    <ol className="m-0 flex list-none flex-col gap-1 p-0">
      {STEPS.map(at => {
        const now = at === step.step, done = at < step.step;
        return <li key={at} data-guide-step={at} aria-current={now ? "step" : undefined} className="flex items-start gap-3">
          <span aria-hidden="true" className={cn("mt-px flex size-5 flex-none items-center justify-center rounded-full text-xs tabular-nums",
            now ? "bg-ink font-semibold text-bg" : done ? "bg-lit text-muted" : "border-hairline border-line text-soft")}>
            {done ? <Icon name="check" className="size-3" /> : at}
          </span>
          <span className="flex min-w-0 flex-col [word-break:auto-phrase]">
            <span className={cn("text-base", now ? "font-semibold text-ink" : "text-muted")}>
              {done && <span className="sr-only">{t("guide.stepDone")} </span>}{said[at].title}</span>
            {(now || !narrow) && <span className={cn("text-sm text-pretty", now ? "text-muted" : "text-soft")}>{said[at].detail}</span>}
          </span>
        </li>;
      })}
    </ol>
  </div>;
}

/**
 * Over the list once the first Task is there, one closable line: where the person is in the guide (2/3, 3/3) and what
 * happens next, said from the data alone (whether a row awaits them, and with a question or a result). The section and
 * button it names are given by the words the screen uses for them, so the guide never names what is not there.
 */
export function GuideLine({ step }: { step: GuideStep }) {
  const { t } = useTranslation("tree");
  const section = t("home.turn"), finish = t("ui:coordinatorCard.done");
  const text = { send: t("guide.line.send"), received: "", working: t("guide.line.working", { section }), question: t("guide.line.question", { section }),
    result: t("guide.line.result", { section, finish }), end: t("guide.line.end") }[step.say];
  const end = step.step === 4;
  // On a phone the words take a line of their own under the guide's name, at the line's whole width.
  return <div data-guide-line={step.say} role="status" className="flex items-start gap-3 border-b border-rule bg-bg py-1.5 pr-1 pl-list-text narrow:flex-wrap narrow:gap-x-2 narrow:gap-y-0 narrow:pb-2.5 narrow:pl-3">
    <span className="flex flex-none items-center gap-1.5 pt-1 text-xs font-medium text-muted narrow:flex-1 narrow:self-center narrow:pt-0">
      {end ? <Icon name="check" className="size-3" /> : <i aria-hidden="true" className={cn("size-1.5 rounded-full", step.step === 3 ? "bg-turn" : "bg-working")} />}
      {t("guide.name")}<span className="tabular-nums">{end ? "" : t("guide.progress", { step: step.step })}</span>
    </span>
    <p className="m-0 min-w-0 flex-1 pt-0.5 text-sm text-pretty text-ink [word-break:auto-phrase] narrow:order-last narrow:basis-full narrow:pt-0">{text}</p>
    <CloseGuide />
  </div>;
}
