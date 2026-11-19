/** Runs only inside mermaid-frame.html, whose HTTP CSP forbids all resource acquisition except
 * packaged script modules. Never move rendering into the reader or replace CSP with syntax-specific checks.
 */
import type { DiagramPalette, FrameResult } from "./mermaid-protocol";
import { contrast, srgb } from "./mermaid-colors";
let runtime: Promise<typeof import("mermaid")["default"]> | undefined;
let sequence = 0;

/** Explicit role assignments prevent Mermaid's automatic complementary/inverse colours from replacing app ink. */
function themeVariables(p: DiagramPalette) {
  const vars: Record<string, string | boolean | number | object> = { darkMode: p.theme === "dark", fontFamily: p.fontFamily, background: p.card,
    // Colours are already mixed onto the card; avoid a second, chart-specific washout.
    pieOpacity: 1, dropShadow: "none" };
  const assign = (names: string, value: string) => { for (const name of names.split(" ")) vars[name] = value; };
  assign("primaryColor mainBkg nodeBkg actorBkg activationBkgColor personBkg stateBkg compositeTitleBackground requirementBackground", p.node);
  assign("primaryBorderColor nodeBorder actorBorder activationBorderColor personBorder compositeBorder requirementBorderColor labelBoxBorderColor flowContainerStroke border2", p.nodeBorder);
  assign("primaryTextColor secondaryTextColor tertiaryTextColor textColor nodeTextColor actorTextColor titleColor labelTextColor signalTextColor loopTextColor noteTextColor transitionLabelColor stateLabelColor classText requirementTextColor relationLabelColor taskTextColor taskTextOutsideColor taskTextLightColor taskTextDarkColor taskTextClickableColor scaleLabelColor pieTitleTextColor pieSectionTextColor pieLegendTextColor vennTitleTextColor vennSetTextColor branchLabelColor tagLabelColor commitLabelColor", p.ink);
  assign("lineColor signalColor arrowheadColor actorLineColor defaultLinkColor transitionColor relationColor archEdgeColor archEdgeArrowColor todayLineColor vertLineColor", p.muted);
  assign("edgeLabelBackground labelBoxBkgColor labelBackgroundColor relationLabelBackground tagLabelBackground commitLabelBackground", p.card);
  assign("clusterBkg compositeBackground", p.cluster);
  assign("clusterBorder archGroupBorderColor", p.clusterBorder);
  assign("noteBkgColor", p.note);
  assign("noteBorderColor", p.noteBorder);
  assign("rowOdd rowEven attributeBackgroundColorOdd attributeBackgroundColorEven altSectionBkgColor excludeBkgColor", p.card);
  assign("secondaryColor taskBkgColor sectionBkgColor", p.series[0]!);
  assign("tertiaryColor doneTaskBkgColor sectionBkgColor2", p.series[1]!);
  assign("activeTaskBkgColor", p.series[2]!);
  assign("critBkgColor", p.series[4]!);
  assign("secondaryBorderColor tertiaryBorderColor taskBorderColor activeTaskBorderColor doneTaskBorderColor critBorderColor pieStrokeColor pieOuterStrokeColor", p.seriesBorder);
  assign("gridColor", p.nodeBorder);
  // Sequence numbers sit on signal-coloured disks, rather than on the card.
  assign("sequenceNumberColor", p.card);
  for (let i = 0; i < 12; i++) {
    const fill = p.series[i % p.series.length]!;
    for (const name of [`cScale${i}`, `pie${i + 1}`, `venn${i + 1}`, `git${i}`, `fillType${i}`]) vars[name] = fill;
    for (const name of [`cScaleLabel${i}`, `gitBranchLabel${i}`, `gitInv${i}`]) vars[name] = p.ink;
  }
  vars.xyChart = { backgroundColor: p.card, titleColor: p.ink, xAxisLabelColor: p.ink, yAxisLabelColor: p.ink,
    xAxisTitleColor: p.ink, yAxisTitleColor: p.ink, xAxisTickColor: p.muted, yAxisTickColor: p.muted,
    xAxisLineColor: p.muted, yAxisLineColor: p.muted, plotColorPalette: p.series.join(",") };
  return vars;
}

/** Mermaid emits author style/classDef paint on shapes and author text colour on labels.
 * Work on that common SVG node contract, never on diagram syntax or per-diagram databases. */
function readableAuthorFill(image: Element, palette: DiagramPalette) {
  for (const node of image.querySelectorAll<SVGGElement>("g.node")) {
    const shape = [...node.querySelectorAll<SVGElement>("rect,polygon,path,circle,ellipse")]
      .find(shape => shape.style.fill && document.defaultView!.CSS.supports("color", shape.style.fill));
    if (!shape) continue;
    const fill = srgb(shape.style.fill, document, palette.card);
    const color = contrast(fill, palette.ink) >= contrast(fill, palette.card) ? palette.ink : palette.card;
    for (const text of node.querySelectorAll<SVGTextElement>("text")) {
      let explicit = false;
      for (let at: Element | null = text; at; at = at.parentElement) {
        const style = (at as SVGElement).style;
        if (style.fill || style.color || at.hasAttribute("fill")) { explicit = true; break; }
        if (at === node) break;
      }
      if (explicit) continue;
      text.style.setProperty("fill", color, "important");
      text.style.setProperty("color", color, "important");
    }
  }
}

export async function renderMermaidSvg(source: string, palette: DiagramPalette): Promise<FrameResult> {
  const id = `alpacawork-mermaid-${++sequence}`;
  let host: HTMLElement | undefined, blocked: string | undefined;
  const violation = (event: SecurityPolicyViolationEvent) => { blocked = `Diagram resource blocked by CSP (${event.effectiveDirective})`; };
  document.addEventListener("securitypolicyviolation", violation);
  try {
    document.body.style.fontFamily = palette.fontFamily;
    const mermaid = await (runtime ??= import("mermaid").then(({ default: mermaid }) => mermaid));
    // Reinitialize for each serialized render: no previous source/config or theme leaks into the next diagram.
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict", suppressErrorRendering: true,
      // Wrapping is a maximum; short labels should not inherit Mermaid 12's 120px minimum node width.
      htmlLabels: false, flowchart: { htmlLabels: false, wrappingWidth: 280, minNodeWidth: 0 }, fontFamily: palette.fontFamily, look: "classic",
      theme: "base", darkMode: palette.theme === "dark", themeVariables: themeVariables(palette),
      secure: ["secure", "securityLevel", "startOnLoad", "suppressErrorRendering", "htmlLabels", "flowchart", "fontFamily", "dompurifyConfig", "maxTextSize", "themeCSS", "theme", "themeVariables", "darkMode", "look", "dropShadow"],
    });
    await mermaid.parse(source);
    host = document.createElement("div");
    host.dataset.mermaidRender = "";
    document.body.append(host);
    const { svg } = await mermaid.render(id, source, host);
    // Browser CSP violation notifications are queued tasks. Let them arrive before reporting success.
    await new Promise(resolve => setTimeout(resolve, 0));
    if (blocked) return { ok: false, reason: blocked };
    const image = new DOMParser().parseFromString(svg, "image/svg+xml").documentElement;
    // SVG-as-img cannot inherit the app's color. Resolve currentColor at the shared output root;
    // explicit author colours on descendants continue to take precedence over inheritance.
    image.setAttribute("style", `${image.getAttribute("style") ?? ""};background:transparent!important;color:${palette.muted}`);
    readableAuthorFill(image, palette);
    const bounds = image.getAttribute("viewBox")?.trim().split(/[\s,]+/).map(Number);
    const size = bounds?.length === 4 && bounds.every(Number.isFinite) && bounds[2]! > 0 && bounds[3]! > 0
      ? { width: bounds[2]!, height: bounds[3]! } : {};
    if (size.width) {
      image.setAttribute("width", String(size.width));
      image.setAttribute("height", String(size.height));
    }
    return { ok: true, svg: new XMLSerializer().serializeToString(image), ...size };
  } catch (error) {
    return { ok: false, reason: blocked ?? (error instanceof Error ? error.message : String(error)) };
  } finally {
    document.removeEventListener("securitypolicyviolation", violation);
    host?.remove();
    for (const name of [id, `d${id}`, `i${id}`]) document.getElementById(name)?.remove();
  }
}
