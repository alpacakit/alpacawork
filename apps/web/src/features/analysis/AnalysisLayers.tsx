import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { ReadFailure } from "@/components/ui/loadable";
import { RegionSkeleton } from "@/components/ui/skeleton";
import { failedAddress } from "@/lib/failed-address";
import { giveFocusBack, openerChain } from "@/lib/focus-return";
import { cn } from "@/lib/utils";
import { closeAnalysisLayer } from "@/state/history-step";
import { useNarrow } from "@/state/view-store";
import { CardPreview, CardSkeleton } from "./CardPreview";
import { useCardReads } from "./data";
import { listTitle } from "./lists";
import { PointerTip, useChoices } from "./parts";
import { analysisSurfaces, type AnalysisPlace } from "./place";

/** The panel and its loading state are ready with the face. Fetch the panel bodies separately. */
type LayersPart = typeof import("./Layers");
let layersPart: LayersPart | undefined;
export const loadAnalysisLayers = (again?: string) => (again ? import(/* @vite-ignore */ again) as Promise<LayersPart>
  : import("./Layers")).then(part => layersPart = part);

function useLayerContent() {
  const [part, setPart] = useState(layersPart);
  const [attempt, setAttempt] = useState<{ again?: string; failure?: unknown }>({});
  useEffect(() => {
    if (part || "failure" in attempt) return;
    let live = true;
    const loaded = layersPart ? Promise.resolve(layersPart) : loadAnalysisLayers(attempt.again);
    loaded.then(next => { if (live) setPart(next); }, failure => { if (live) setAttempt({ ...attempt, failure }); });
    return () => { live = false; };
  }, [part, attempt]);

  const retry = () => {
    const address = failedAddress(attempt.failure);
    // A dynamic import remembers a failure by URL. Ask at a fresh address or reload if the browser gave no address.
    if (!address) { location.reload(); return; }
    setAttempt({ again: `${address.split("?")[0]}?again=${Date.now()}` });
  };
  return { part, attempt, retry };
}

function CardLayer({ place, project, part, waitFrom }: {
  place: AnalysisPlace; project: string | null; part: LayersPart | undefined; waitFrom: number;
}) {
  const bucket = useChoices(state => state.bucket);
  const reads = useCardReads(project, place.span, place.card!, bucket);
  return part ? <part.CardPane place={place} reads={reads} waitFrom={waitFrom} />
    : <CardPreview><CardSkeleton waitFrom={waitFrom} /></CardPreview>;
}

/**
 * What a number opens: the list of the tasks behind it, then one task's values; or the share card. The same surface as the reader on the
 * list of tasks (lit, a hairline edge, 12px from the right and the top), the page behind it kept as it is; on a phone a
 * sheet from the bottom. × and a press behind it close every layer; the list's way back and Back close one.
 */
export function AnalysisLayers({ place, project, days }: { place: AnalysisPlace; project: string | null; days: { from: string; to: string } | null }) {
  const { t } = useTranslation("analysis");
  const narrow = useNarrow();
  const surface = useRef<HTMLElement | null>(null);
  const [surfaceBox, setSurfaceBox] = useState<HTMLElement | null>(null);
  const setSurface = useCallback((node: HTMLElement | null) => { surface.current = node; setSurfaceBox(node); }, []);
  const depth = analysisSurfaces(place).length;
  const content = useLayerContent();
  // Back to the layer under it, where there is one; × and a press behind close them all.
  const back = depth > 1;
  useEffect(() => {
    if (!depth) return;
    const key = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); closeAnalysisLayer(depth - 1); } };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [depth]);
  // A layer that opens takes the focus on its first control; back from one task to its list, the focus is on that task's
  // row again (the list is drawn from what it had read), as every window gives the focus back to what opened it.
  const shownUnit = useRef<string | null>(null);
  useEffect(() => {
    const from = shownUnit.current;
    shownUnit.current = place.unit;
    const row = !place.unit && from ? surface.current?.querySelector<HTMLElement>(`[data-unit-row="${from}"]`) : null;
    (row ?? surface.current?.querySelector<HTMLElement>("[data-layer-focus]"))?.focus({ preventScroll: !row });
  }, [place.list, place.unit, place.card]);
  // As every window does: what had the focus when the first layer opened gets it back when the last one closes (a
  // chart and its legend give it back to themselves, ChartGroup).
  const opener = useRef<Element[]>([]), open = depth > 0;
  useLayoutEffect(() => {
    if (open) { opener.current = openerChain(document.activeElement); return; }
    const chain = opener.current;
    opener.current = [];
    giveFocusBack(chain);
  }, [open]);
  if (!depth) return null;
  return <>
    {/* A press behind the window closes it; the bar stays in reach above it (its faces, the project, settings). */}
    <div aria-hidden className="fixed inset-x-0 top-(--bar-h) bottom-0 z-(--layer-reader)" onClick={() => closeAnalysisLayer(0)} />
    <PointerTip root={surfaceBox} />
    {/* On a computer it is a panel at the window's right: the coordinator's input stands left of it, as beside the reader. */}
    <aside ref={setSurface} role="dialog" data-analysis-panel={narrow ? undefined : ""} aria-label={place.card ? t("card.make") : place.unit ?? (place.list ? listTitle(place.list) : "")}
      className={cn("fixed z-(--layer-reader) flex flex-col border-hairline border-lit-line bg-lit shadow-float",
        narrow ? "inset-x-0 top-[18%] bottom-0 animate-sheet rounded-t-pane before:absolute before:top-1.5 before:left-1/2 before:-ms-4.5 before:h-1 before:w-9 before:rounded-xs before:bg-lit-line"
          : "top-window right-window bottom-window w-[min(548px,calc(100%-24px))] animate-side rounded-pane")}>
      <div className={cn("flex min-h-12 items-center gap-2 pt-3.5 pe-3 pb-1.5 ps-6", narrow && "pt-4.5 pe-2 ps-4")}>
        {back && <button type="button" data-layer-focus onClick={() => closeAnalysisLayer(1)}
          className="-ms-2 inline-flex h-7 items-center gap-0.5 rounded-md ps-1 pe-2.5 text-muted hover:bg-hover hover:text-ink">
          <Icon name="left" className="size-3.5" />{t("list.back")}</button>}
        {place.unit && <span className="text-muted">{place.unit}</span>}
        <span className="me-auto" />
        <Button variant="ghost" size="icon" aria-label={t("list.close")} title={t("list.close")} data-layer-focus={back ? undefined : ""}
          onClick={() => closeAnalysisLayer(0)}><Icon name="close" /></Button>
      </div>
      <div data-analysis-layer className="min-h-0 flex-1 overflow-auto px-6 narrow:px-4">
        <LayerBody place={place} project={project} days={days} content={content} />
      </div>
    </aside>
  </>;
}

function LayerBody({ place, project, days, content: { part, attempt, retry } }: {
  place: AnalysisPlace;
  project: string | null;
  days: { from: string; to: string } | null;
  content: ReturnType<typeof useLayerContent>;
}) {
  const [waitFrom] = useState(() => performance.now());
  if ("failure" in attempt) return <ReadFailure size="region" error={attempt.failure} retry={retry} />;
  if (place.card) return <CardLayer place={place} project={project} part={part} waitFrom={waitFrom} />;
  if (!part) return <RegionSkeleton shape={place.unit ? "analysisTask" : "analysisList"} waitFrom={waitFrom} />;
  if (place.unit) return <part.UnitPane key={place.unit} unit={place.unit} />;
  return place.list && <part.ListPane key={JSON.stringify(place.list)} place={place} project={project} days={days} />;
}
