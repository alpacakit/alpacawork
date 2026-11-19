/** Private, same-origin message boundary between the reader and its CSP-isolated renderer. */
export const MERMAID_CHANNEL = "alpacawork-mermaid";
export const MERMAID_FRAME_PATH = "/mermaid-frame.html";
export const MERMAID_TIMEOUT_MS = 15_000;
export type DiagramTheme = "light" | "dark";
const PALETTE_COLORS = ["card", "node", "note", "cluster", "ink", "muted", "nodeBorder", "noteBorder", "clusterBorder", "seriesBorder"] as const;
export type DiagramPalette = { theme: DiagramTheme; fontFamily: string; series: string[] } & Record<(typeof PALETTE_COLORS)[number], string>;
export type DiagramSize = { width?: number; height?: number };
export type FrameResult = ({ ok: true; svg: string } & DiagramSize) | { ok: false; reason: string };
export type FrameRequest = { channel: typeof MERMAID_CHANNEL; id: number; source: string; palette: DiagramPalette };
type FrameReply = { channel: typeof MERMAID_CHANNEL; id: number; result: FrameResult };

export function isFrameRequest(value: unknown): value is FrameRequest {
  if (!value || typeof value !== "object") return false;
  const data = value as Partial<FrameRequest>;
  const p = data.palette;
  return data.channel === MERMAID_CHANNEL && Number.isSafeInteger(data.id) && typeof data.source === "string" && !!p &&
    (p.theme === "light" || p.theme === "dark") && typeof p.fontFamily === "string" &&
    PALETTE_COLORS.every(name => hex(p[name])) &&
    Array.isArray(p.series) && p.series.length === 6 && p.series.every(hex);
}
const hex = (color: unknown) => typeof color === "string" && /^#[\da-f]{6}$/i.test(color);
export function isFrameReply(value: unknown): value is FrameReply {
  if (!value || typeof value !== "object") return false;
  const data = value as Partial<FrameReply>, result = data.result;
  if (data.channel !== MERMAID_CHANNEL || !Number.isSafeInteger(data.id) || !result || typeof result !== "object") return false;
  if (result.ok === false) return typeof result.reason === "string";
  return result.ok === true && typeof result.svg === "string" && [result.width, result.height].every(size => size === undefined || (Number.isFinite(size) && size > 0));
}
