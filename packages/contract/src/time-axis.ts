/** Activity for an axis, independent of the interval whose records the screen happens to have read. */
export type Busy = readonly (readonly [from: number, to: number | null])[];
const AXIS_PAD_MIN_MS = 3 * 60_000;
const AXIS_GAP_MIN_MS = 20 * 60_000;
export const AXIS_JOIN_MS = 2 * AXIS_PAD_MIN_MS + AXIS_GAP_MIN_MS;
export const axisPad = (viewMs: number) => Math.max(AXIS_PAD_MIN_MS, viewMs * 0.012);
export const axisMinGap = (viewMs: number) => Math.max(AXIS_GAP_MIN_MS, viewMs * 0.05);

/** Finite stretches this close merge at every supported zoom. Open work ends at the reader's clock, not infinity. */
export function joinBusy(spans: Busy): [number, number | null][] {
  const finite = spans.filter((span): span is readonly [number, number] => span[1] !== null)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const joined: [number, number | null][] = [];
  for (const [from, to] of finite) {
    const last = joined.at(-1);
    if (last && from - last[1]! < AXIS_JOIN_MS) last[1] = Math.max(last[1]!, to);
    else joined.push([from, to]);
  }
  let openFrom: number | undefined;
  for (const [from, to] of spans) {
    if (to === null) openFrom = Math.min(openFrom ?? Infinity, from);
  }
  if (openFrom !== undefined) joined.push([openFrom, null]);
  return joined.sort((a, b) => a[0] - b[0]);
}

/** Resolve an event's position once, before either selecting its window or drawing its mark. */
export function timeMarkAt(event: { id: string; at: string }, logs: ReadonlyMap<string, { at: string; causeAt?: string }>): string {
  const log = logs.get(event.id);
  return log?.causeAt ?? log?.at ?? event.at;
}
