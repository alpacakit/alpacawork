export type ObservedMotion = { state: string; endTime: unknown; name?: string | null; placeholder?: boolean; liveMark?: boolean; runningStep?: boolean; workMark?: boolean; workingPill?: boolean; deliveryStatus?: boolean; target?: unknown; targetIndex?: number; timing?: unknown };
/** Only source-identified endless pulses are ambient: RegionSkeleton's animate-placeholder/motion-pulse pair (skeleton.tsx/styles.css),
 * a live timeline mark's glyph (timeline-mark.tsx `live`), which pulses as long as the work goes on, a running step's
 * mark (RunSteps.tsx StepRow, `running`), which pulses as long as that step runs, the work mark's three dots (RunSteps.tsx
 * WorkMark, mark-weave-turn and mark-weave-dot), which go round as long as the agent works; the folded conversation's
 * dot while the coordinator works (LastWordsPill, `running`); and a queue action’s delivery status while its request is pending. Spin, ordinary pulse, progress-flow, unknown and finite paused motion still block. */
export const excludedAmbientPulse = (motion: ObservedMotion) => motion.endTime === Infinity
  && (motion.name === 'motion-pulse' && (motion.placeholder === true || motion.liveMark === true || motion.runningStep === true || motion.workingPill === true || motion.deliveryStatus === true)
    || motion.workMark === true && (motion.name === 'mark-weave-turn' || motion.name === 'mark-weave-dot'));
export function motionHasSettled(motion: ObservedMotion[], finiteOnly: boolean) {
  return motion.every(each => finiteOnly && excludedAmbientPulse(each) || each.state === 'finished' || each.state === 'idle');
}
