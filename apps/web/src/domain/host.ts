/** How the Resources tab writes its numbers and draws its lines. */
import type { HostEpisode } from "@alpacawork/contract";

const GB = 1024 ** 3;

/** A share of the whole machine: a busy Run on many cores is a few percent, so small values keep one decimal. */
export function formatPercent(value: number | null, locale: string): string {
  if (value === null) return "—";
  const digits = value >= 0.05 && value < 10 ? 1 : 0;
  return new Intl.NumberFormat(locale, { style: "percent", minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value / 100);
}

export function formatGigabytes(bytes: number | null, locale: string): string {
  if (bytes === null) return "—";
  const gb = bytes / GB;
  return gigabytes(gb, locale, gb < 100 ? 1 : 0, true);
}

function gigabytes(gb: number, locale: string, digits: number, unit: boolean): string {
  return new Intl.NumberFormat(locale, { ...(unit ? { style: "unit", unit: "gigabyte" } as const : {}), useGrouping: false,
    minimumFractionDigits: digits, maximumFractionDigits: digits }).format(gb);
}

/** Whole minutes, at least one, for a stretch shown as "12m". */
export const spanMinutes = (from: number, to: number) => Math.max(1, Math.round((to - from) / 60_000));

/** What was tight and how far, in the order the measures were recorded. */
export function episodeReasons(episode: HostEpisode, locale: string): { kind: HostEpisode["kinds"][number]; value: string }[] {
  return episode.kinds.map((kind) => ({ kind,
    value: kind === "cpu" ? formatPercent(episode.peak.cpu, locale) : kind === "memory" ? formatPercent(episode.peak.memoryFreePercent, locale)
      : formatGigabytes(episode.peak.diskFreeBytes, locale) }));
}

/** "RTX 6000 Ada ×2" or "RTX 4090 · RTX 3090": the machine's GPUs by model, without the maker's name. */
export function gpuModels(gpus: readonly { name: string }[]): string {
  const counts = new Map<string, number>();
  for (const gpu of gpus) {
    const name = gpu.name.replace(/^(NVIDIA|AMD|Intel)\s+/i, "").replace(/\s+Generation$/i, "");
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts].map(([name, count]) => count > 1 ? `${name} ×${count}` : name).join(" · ");
}

export type SparkPoint = { at: number; value: number | null };
/**
 * One line over a fixed time window (0–100 on the value axis), the dashed line at `line`, and the stretches on the
 * tight side of it shaded. Points without a value break the line. Each piece of line also has an area that closes it
 * toward the side that is taken (the bottom for a share in use, the top for a share free), and `last` is the newest
 * point drawn. Coordinates are in a `width`×`height` box.
 */
export function sparkShape(points: readonly SparkPoint[], window: { from: number; to: number }, line: number, tightBelow: boolean,
  width: number, height: number, step: number) {
  const span = Math.max(1, window.to - window.from);
  const x = (at: number) => ((at - window.from) / span) * width;
  const y = (value: number) => height - 2 - (Math.max(0, Math.min(100, value)) / 100) * (height - 4);
  const pieces: { x: number; y: number }[][] = [];
  let current: { x: number; y: number }[] = [];
  const bands: { x: number; width: number }[] = [];
  for (const point of points) {
    if (point.value === null || point.at < window.from) { if (current.length) pieces.push(current); current = []; continue; }
    current.push({ x: x(point.at), y: y(point.value) });
    if (tightBelow ? point.value < line : point.value >= line) {
      const left = Math.max(0, x(point.at - step));
      bands.push({ x: left, width: Math.max(1, x(point.at) - left) });
    }
  }
  if (current.length) pieces.push(current);
  const draw = (piece: readonly { x: number; y: number }[]) => piece.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join("");
  const edge = tightBelow ? 0 : height;
  const areas = pieces.map((piece) => `${draw(piece)}L${piece[piece.length - 1]!.x.toFixed(1)} ${edge}L${piece[0]!.x.toFixed(1)} ${edge}Z`);
  return { paths: pieces.map(draw), areas, bands, lineY: y(line), last: pieces[pieces.length - 1]?.at(-1) ?? null };
}

/** "42.5 / 48 GB": a GPU's VRAM in use over its whole, as nvidia-smi reads, the whole rounded as a card is sold (47.99 GiB reads 48). */
export function formatVramUsed(memory: { usedBytes: number; totalBytes: number }, locale: string): string {
  const used = memory.usedBytes / GB;
  const whole = memory.totalBytes / GB;
  const wholeDigits = Number.isInteger(Math.round(whole * 10) / 10) ? 0 : 1;
  return `${gigabytes(used, locale, used < 100 ? 1 : 0, false)} / ${gigabytes(whole, locale, wholeDigits, true)}`;
}
