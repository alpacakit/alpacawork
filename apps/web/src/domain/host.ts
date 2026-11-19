/** How the Host status tab writes its numbers and draws its lines. */
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
  const digits = gb < 100 ? 1 : 0;
  return new Intl.NumberFormat(locale, { style: "unit", unit: "gigabyte", minimumFractionDigits: digits, maximumFractionDigits: digits }).format(gb);
}

/** Whole minutes, at least one, for a stretch shown as "12m". */
export const spanMinutes = (from: number, to: number) => Math.max(1, Math.round((to - from) / 60_000));

/** What was tight and how far, in the order the measures were recorded. */
export function episodeReasons(episode: HostEpisode, locale: string): { kind: HostEpisode["kinds"][number]; value: string }[] {
  return episode.kinds.map((kind) => ({ kind,
    value: kind === "cpu" ? formatPercent(episode.peak.cpu, locale) : kind === "memory" ? formatPercent(episode.peak.memoryFreePercent, locale)
      : formatGigabytes(episode.peak.diskFreeBytes, locale) }));
}

export type SparkPoint = { at: number; value: number | null };
/**
 * One line over a fixed time window (0–100 on the value axis), the dashed line at `line`, and the stretches on the
 * tight side of it shaded. Points without a value break the line. Coordinates are in a `width`×`height` box.
 */
export function sparkShape(points: readonly SparkPoint[], window: { from: number; to: number }, line: number, tightBelow: boolean,
  width: number, height: number, step: number) {
  const span = Math.max(1, window.to - window.from);
  const x = (at: number) => ((at - window.from) / span) * width;
  const y = (value: number) => height - 2 - (Math.max(0, Math.min(100, value)) / 100) * (height - 4);
  const paths: string[] = [];
  let current = "";
  const bands: { x: number; width: number }[] = [];
  for (const point of points) {
    if (point.value === null || point.at < window.from) { if (current) paths.push(current); current = ""; continue; }
    current += `${current ? "L" : "M"}${x(point.at).toFixed(1)} ${y(point.value).toFixed(1)}`;
    if (tightBelow ? point.value < line : point.value >= line) {
      const left = Math.max(0, x(point.at - step));
      bands.push({ x: left, width: Math.max(1, x(point.at) - left) });
    }
  }
  if (current) paths.push(current);
  return { paths, bands, lineY: y(line) };
}
