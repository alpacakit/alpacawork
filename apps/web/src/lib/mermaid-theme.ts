import { appliedTheme } from "@/state/theme";
import { contrast, srgb, tint } from "./mermaid-colors";
import type { DiagramPalette } from "./mermaid-protocol";

const tokens = ["raised", "hover", "line", "bg", "lit", "ink", "muted", "soft", "working", "done", "turn", "changed", "stopped", "todo"] as const;
const palettes = new WeakMap<Document, { signature: string; palette: DiagramPalette }>();

/** One CSS→sRGB boundary. The stable snapshot also changes when CSS/font values change within a theme. */
export function diagramPalette(at: Document): DiagramPalette {
  const theme = appliedTheme(at), style = at.defaultView!.getComputedStyle(at.documentElement);
  const values = tokens.map(name => style.getPropertyValue(`--${name}`).trim());
  const fontFamily = style.getPropertyValue("--font-sans").trim();
  const signature = JSON.stringify([theme, fontFamily, values]);
  const kept = palettes.get(at);
  if (kept?.signature === signature) return kept.palette;
  const colors = Object.fromEntries(tokens.map((name, i) => [name, srgb(values[i]!, at)])) as Record<typeof tokens[number], string>;
  const { raised: card, ink, muted, soft, hover: note } = colors;
  const node = theme === "dark" ? colors.line : colors.hover, cluster = theme === "dark" ? colors.lit : colors.bg;
  const cardContrast = contrast(soft, card);
  const border = (ground: string) => Math.min(contrast(soft, ground), cardContrast) >= 3 ? soft : muted;
  const series = ["working", "done", "turn", "changed", "stopped", "todo"]
    .map(name => tint(colors[name as keyof typeof colors], card, theme === "dark" ? 0.45 : 0.40));
  const palette: DiagramPalette = { theme, fontFamily, card, node, note, cluster, ink, muted,
    nodeBorder: border(node), noteBorder: border(note), clusterBorder: border(cluster),
    series, seriesBorder: series.every(fill => border(fill) === soft) ? soft : muted,
  };
  palettes.set(at, { signature, palette });
  return palette;
}
