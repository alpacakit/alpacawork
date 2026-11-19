/**
 * Whether a slide jumps, read frame by frame. Its element's place and its animation's own clock are taken on one clock,
 * the document timeline the animation runs on (a requestAnimationFrame time is that frame's), so a slide whose clock
 * starts late (it waited on a busy frame, and starts where its clock is by then) is told from one whose place or clock
 * jumps.
 */
import type { Page } from '@playwright/test';

/**
 * One frame of a watched slide: where its element is, when (the document timeline's time), its animation's own clock
 * (null with none), and when on that timeline the slide it goes on began (null with none).
 */
export type SlideSample = { x: number; y: number; at: number; clock: number | null; began: number | null };
declare global { interface Window { slideSample: () => SlideSample } }

/**
 * From now on, `window.slideSample()` reads the element `selector` finds and the animation last made on one. A slide
 * begins when an animation is made with no clock of its own; one given a clock as it is made (answer-chips carries a
 * replaced element's timeline to the new one) goes on from when the one before it began.
 */
export async function watchSlide(page: Page, selector: string) {
  await page.evaluate(selector => {
    const animate = Element.prototype.animate;
    let slide: { animation: Animation; began: number } | null = null;
    Element.prototype.animate = function (this: Element, frames, options) {
      const made = animate.call(this, frames, options);
      if (this.matches(selector)) {
        const before = slide, current = { animation: made, began: Number(document.timeline.currentTime) };
        slide = current;
        // The clock it is given is set right after it is made; read it once that has run.
        queueMicrotask(() => {
          const given = Number(made.currentTime ?? 0);
          if (given > 0) current.began = before ? before.began : current.began - given;
        });
      }
      return made;
    };
    window.slideSample = () => {
      const box = document.querySelector(selector)!.getBoundingClientRect();
      const live = slide && slide.animation.playState !== 'idle' ? slide : null;
      return { x: box.left, y: box.top, at: Number(document.timeline.currentTime),
        clock: live ? Number(live.animation.currentTime ?? 0) : null, began: live?.began ?? null };
    };
  }, selector);
}

/**
 * The jumps in a watched slide's frames. A frame moves at most 1.5px per ms of what passed in it (never less than a
 * frame's 25px): the frame's time, or as much as the slide's own clock moved, which may start late but never runs
 * ahead of the time since its slide began. A clock ahead of that, or a move past its bound, is a jump.
 */
export function slideJumps(samples: readonly SlideSample[]): string[] {
  const jumps: string[] = [];
  samples.forEach((sample, at) => {
    if (sample.clock !== null && sample.began !== null && sample.clock > sample.at - sample.began + 1)
      jumps.push(`frame ${at}: its clock ${sample.clock}ms is ahead of the ${sample.at - sample.began}ms since its slide began`);
    const before = samples[at - 1];
    if (!before) return;
    const frame = sample.at - before.at;
    const clock = sample.clock === null ? 0 : sample.clock - (before.clock ?? 0);
    const distance = Math.hypot(sample.x - before.x, sample.y - before.y);
    if (distance >= Math.max(25, 1.5 * Math.max(frame, clock)))
      jumps.push(`frame ${at}: moved ${distance}px in ${frame}ms, its clock ${clock}ms`);
  });
  return jumps;
}
