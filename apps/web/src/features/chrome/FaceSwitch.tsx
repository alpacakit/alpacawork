import { useTranslation } from "react-i18next";
import { TAB, TabLabel, TabMarker } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { faceOf, readerShows, useViewStore, type FaceName } from "@/state/view-store";
import { closeAnalysisLayer } from "@/state/history-step";
import { openAnalysis } from "@/features/analysis/open";
import { analysisSurfaces } from "@/features/analysis/place";
import { openAutomations } from "@/features/automations/open";
import { useAutomationsAttention } from "@/features/automations/data";

/**
 * The bar's faces, beside the project's name: the list of tasks to work with (Use), what the records count (Analysis),
 * and what runs by itself (Automations). Each face is the whole screen; the switch stays in one place on every face, and
 * every face is shown through the store's one move of the face (`showAutomations`, `showAnalysis`). Coming back to the
 * analysis or the automations finds them as they were left. Automations carries a dot while one asks for a look (a run
 * that failed, one that went off by itself). `onChose` follows a choice (the folded bar's menu closes).
 */
export function FaceSwitch({ className, onChose }: { className?: string; onChose?: () => void }) {
  const { t } = useTranslation("chrome");
  const automations = useViewStore(state => state.automations), analysis = useViewStore(state => state.analysis);
  const face = faceOf({ automations, analysis });
  const attention = useAutomationsAttention().length;
  const automationsTip = attention > 0 ? `${t("face.automations")} · ${t("face.automationsAttention", { count: attention })}` : t("face.automations");
  const show = (next: FaceName) => next === "automations" ? openAutomations() : next === "analysis" ? openAnalysis() : useViewStore.getState().showAutomations(null);
  const press = (next: FaceName) => {
    if (next !== face) show(next);
    // Analysis pressed while something is open over it (a list, the card, a task): they close as × closes them.
    else if (face === "analysis" && (analysisSurfaces(analysis).length || readerShows(useViewStore.getState()))) closeAnalysisLayer(0);
    onChose?.();
  };
  // On a phone the three faces sit closer, so they stay whole beside the name in a longer language too.
  const item = cn(TAB, "aria-[current=true]:font-semibold aria-[current=true]:text-ink narrow:px-1.5");
  return <div role="group" aria-label={t("face.label")} className={cn("relative flex max-w-full min-w-0 flex-none items-center gap-0.5 overflow-x-auto [scrollbar-width:none]", className)}>
    <TabMarker current='[aria-current="true"]' />
    <button type="button" data-face="use" aria-current={face === "use" ? "true" : undefined} onClick={() => press("use")}
      className={item}><TabLabel>{t("face.use")}</TabLabel></button>
    <button type="button" data-face="analysis" aria-current={face === "analysis" ? "true" : undefined} onClick={() => press("analysis")}
      className={item}><TabLabel>{t("face.analysis")}</TabLabel></button>
    <button type="button" data-face="automations" aria-current={face === "automations" ? "true" : undefined}
      // Pointed at, it says what its dot means, as a screen reader hears it.
      aria-label={automationsTip} title={automationsTip} onClick={() => press("automations")} className={item}>
      <TabLabel>{t("face.automations")}</TabLabel>
      {attention > 0 && <span data-automations-attention aria-hidden="true" className="size-2 flex-none rounded-full bg-warn" />}
    </button>
  </div>;
}
