/** Clocks and accepted relative gates. These helpers consume measurements; they do not evaluate product reads. */
export type ResponseFrame = { t: number; time: number; frame: number; ghosts: number; x: number; y: number; opacity: number; stamp: number; scale: number };
export function lifetime(all: ResponseFrame[]) {
  if (!all.length) throw Error('No observed copy frames');
  const at = (f: ResponseFrame) => f.time - all[0]!.time, first = all[0]!;
  const leavingAt = all.findIndex(f => f.ghosts && (Math.hypot(f.x - first.x, f.y - first.y) > 2 || f.opacity < 0.97));
  const before = all.slice(0, leavingAt < 0 ? all.length : leavingAt);
  let still = before.length;
  while (still > 0 && before[still - 1]!.ghosts && before[still - 1]!.stamp >= 0.995 && Math.abs(before[still - 1]!.scale - 1) < 0.003) still--;
  const readable = still < before.length ? at(before[still]!) : Infinity;
  const leaving = leavingAt < 0 ? Infinity : at(all[leavingAt]!);
  const gone = all.find(f => !f.ghosts);
  return { readable, leaving, gone: gone ? at(gone) : Infinity, hold: leaving - readable };
}
export function actualPaint(timeline: any[], marks: { press: number; append: number; firstObservation: number; remove: number }) {
  const stamp = (name: string) => timeline.find(e => e.name === 'TimeStamp' && e.args?.data?.message === name);
  const first = stamp('response-first-observation'), append = stamp('response-append'), removed = stamp('response-remove');
  if (!first || !append || !removed) throw Error('Missing actual trace timestamp markers');
  const paints = timeline.filter(e => e.name === 'Paint' && e.args?.data?.frame === first.args.data.frame);
  if (paints.some(e => e.ts >= append.ts && e.ts < first.ts)) throw Error('Paint before first observation: inspect raw trace, do not call the later Paint first');
  const paint = paints.find(e => e.ts >= first.ts && e.ts < removed.ts);
  if (!paint) throw Error('No actual Paint between first observation and removal');
  return { pressToAppend: marks.append - marks.press, appendToObservation: marks.firstObservation - marks.append,
    pressToPaint: marks.firstObservation - marks.press + (paint.ts - first.ts) / 1000,
    firstPaintTraceUs: paint.ts, observationToPaint: (paint.ts - first.ts) / 1000 };
}
export function responseStats(values: number[]) {
  if (values.length !== 10 || values.some(n => !Number.isFinite(n) || n < 0)) throw Error('Exactly ten finite nonnegative samples are required');
  const sorted = [...values].sort((a, b) => a - b);
  return { median: (sorted[4]! + sorted[5]!) / 2, p95: sorted[9]!, raw: values };
}
export function responseAcceptance(candidate: Record<number, number[]>, main: Record<number, number[]>) {
  const cold = responseStats(candidate[0]!), warm = responseStats(candidate[20]!);
  const comparisons = [0, 20].map(visited => {
    const measured = responseStats(candidate[visited]!), baseline = responseStats(main[visited]!);
    const limit = baseline.median * 1.25 + 10;
    return { visited, measured, baseline, limit, pass: measured.median <= limit };
  });
  const growth = { actual: warm.median - cold.median, limit: Math.max(20, cold.median * 0.25) };
  return { comparisons, growth: { ...growth, pass: growth.actual <= growth.limit },
    // 80 groups is an investigation boundary. It cannot silently stand in for either acceptance condition.
    boundary80: { candidate: responseStats(candidate[80]!), main: responseStats(main[80]!) } };
}
