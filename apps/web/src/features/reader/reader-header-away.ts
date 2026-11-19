import { useCallback, useLayoutEffect, useRef, type RefObject } from "react";
import { watchLayerHeight, watchScrollAway } from "@/lib/scroll-away";

/** The header overlays its reading area on a phone: measure its room, then move only the header, never the text. */
export function useReaderHeaderAway(header: RefObject<HTMLDivElement | null>, content: RefObject<HTMLDivElement | null>, enabled: boolean, place: string, placing: RefObject<string | null>) {
  const tracking = useRef<ReturnType<typeof watchScrollAway> | null>(null);
  useLayoutEffect(() => {
    const layer = header.current, area = content.current;
    if (!layer || !area) return;
    // The measured layer owns the room in the text.
    const room = area.parentElement!.style, kept = Number.parseFloat(room.getPropertyValue("--reader-header-h"));
    let height = Number.isFinite(kept) ? kept : 0;
    const unwatch = watchLayerHeight(layer, measured => {
      height = measured;
      room.setProperty("--reader-header-h", `${measured}px`);
    }, Number.isFinite(kept) ? kept : undefined);
    const setHidden = (hidden: boolean) => {
      layer.dataset.readerHeader = hidden ? "hidden" : "shown";
      layer.inert = hidden;
    };
    setHidden(false);
    tracking.current = enabled ? watchScrollAway({
      source: area, accepts: element => element === area && placing.current === null,
      height: () => height, hidden: () => layer.dataset.readerHeader === "hidden", setHidden,
      controls: () => layer,
    }) : null;
    return () => { tracking.current?.stop(); tracking.current = null; unwatch(); setHidden(false); };
  }, [header, content, enabled, place, placing]);
  const reset = useCallback(() => {
    if (content.current) tracking.current?.reset(content.current);
  }, [content]);
  const rebase = useCallback(() => {
    if (content.current) tracking.current?.rebase(content.current);
  }, [content]);
  return { reset, rebase };
}
