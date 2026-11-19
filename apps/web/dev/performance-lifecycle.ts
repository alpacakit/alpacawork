import { emptyLifecycle, type Lifecycle, type ReturnTrigger } from '../../backend/src/diagnostics/protocol.ts';

const elapsed = (now: number, before: number | null) => before === null || !Number.isFinite(now - before) || now - before < 0 || now - before > 1e12 ? null : now - before;
const visibility = (state: string): Lifecycle['initialVisibility'] => state === 'visible' || state === 'hidden' ? state : 'unknown';

/** One page lifetime, outside five-second resets and BFCache collector instances.
 * These are observed notifications, never a count of resumes or proof of OS sleep. */
export function createLifecycle(state: string, wall = Date.now()) {
  let current = visibility(state);
  const values = { ...emptyLifecycle(), initialVisibility: current, hiddenObserved: current === 'hidden' };
  const triggers = new Set<ReturnTrigger>();
  let hiddenAt: number | null = current === 'hidden' ? wall : null;
  let hiddenEnd: number | null = null, lastTrigger: number | null = null;
  let previousWall: number | null = null, previousPerf: number | null = null;
  const returned = (trigger: ReturnTrigger, perf = performance.now()) => { triggers.add(trigger); lastTrigger = perf; };
  return {
    visibility(state: string, perf = performance.now(), wall = Date.now()) {
      const next = visibility(state), previous = current; current = next;
      if (next === 'hidden') { values.hiddenObserved = true; hiddenAt ??= wall; }
      if (next === 'visible' && previous !== 'visible') {
        if (hiddenAt !== null) { values.hiddenWallMs = elapsed(wall, hiddenAt); hiddenEnd = values.hiddenWallMs === null ? null : perf; hiddenAt = null; }
        returned('visibility-visible', perf);
      }
    },
    pagehide() { values.pagehideObserved = true; },
    returned,
    sample(perf = performance.now(), wall = Date.now()): Lifecycle {
      return { ...values, triggersSinceSample: [...triggers], sinceHiddenEndPerfMs: elapsed(perf, hiddenEnd),
        sinceReturnTriggerPerfMs: elapsed(perf, lastTrigger), sampleGapWallMs: elapsed(wall, previousWall), sampleGapPerfMs: elapsed(perf, previousPerf) };
    },
    sent(perf: number, wall: number) { previousPerf = perf; previousWall = wall; triggers.clear(); },
  };
}
