import { useCallback, useEffect, useState, useSyncExternalStore, type ImgHTMLAttributes, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useSurfaceDocument } from "@/lib/surface";
import { renderMermaid, type DiagramResult } from "@/lib/mermaid";
import { diagramPalette } from "@/lib/mermaid-theme";
import type { DiagramPalette } from "@/lib/mermaid-protocol";
import { subscribeAppliedTheme } from "@/state/theme";
import { cn } from "@/lib/utils";

/**
 * Body and slider share the same image and failure state; the applied surface theme is authoritative. `enlarge`: a
 * drawing is vector, so where there is room (the slider) it grows up to that many times its own size, still fitting
 * `fit` (the height it may take) and the width.
 */
export function MermaidImage({ source, fallback, renderImage, enlarge, fit, style, className, ...props }: ImgHTMLAttributes<HTMLImageElement> & {
  source: string; fallback: ReactNode; renderImage?: (image: ReactNode) => ReactNode; enlarge?: number; fit?: string;
}) {
  const { t } = useTranslation("reader");
  const at = useSurfaceDocument();
  const palette = useSyncExternalStore(useCallback(notify => subscribeAppliedTheme(at, notify), [at]), () => diagramPalette(at));
  const [rendered, setRendered] = useState<{ source: string; palette: DiagramPalette; result: DiagramResult }>();
  const result = rendered?.source === source && rendered.palette === palette ? rendered.result : undefined;
  useEffect(() => {
    let current = true;
    void renderMermaid(source, palette).then(result => { if (current) setRendered({ source, palette, result }); });
    return () => { current = false; };
  }, [source, palette]);
  const card = "rounded-lg border border-line bg-raised p-3";
  if (!result) return <span role="status" data-diagram-loading className={cn("flex min-h-24 items-center text-sm text-muted", card)}>{t("markdownBody.diagramLoading")}</span>;
  if (!result.ok) return <><span data-diagram-failed className="block text-sm text-muted" title={result.reason}>{t("markdownBody.diagramFailed")}</span>{fallback}</>;
  const grown = enlarge && fit && result.width && result.height
    ? { width: `min(100%, ${result.width * enlarge}px, calc(${fit} * ${result.width / result.height}))` } : undefined;
  const image = <img {...props} className={cn(card, className)} data-diagram-theme={palette.theme} style={{ ...style, ...grown }} src={result.src} draggable={false} onError={() => setRendered({ source, palette,
    result: { ok: false, reason: "SVG image could not be displayed" } })} />;
  return renderImage ? renderImage(image) : image;
}
