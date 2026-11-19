import { duration, easing, reducedMotion, stillCopy } from './motion';
import { FLICK, letGo, type SheetPress } from './sheet-press';

/** One owner of a sheet's drawn height, return and departure. Coordinates grow upwards from its bottom edge. */
export function sheetMotion(el: HTMLElement, geometry: { most: () => number; bottom: () => number; stand: () => number }) {
  let settling: Animation | undefined;
  const shown = () => geometry.bottom() - el.getBoundingClientRect().top;
  // Held, the sheet is its own layer (will-change), moved by the compositor: at a fraction of a screen pixel its one-pixel
  // top edge would be shared between two pixel rows and fade out. It moves by whole screen pixels, so the edge stays one
  // row, as it is at rest.
  const follow = (height: number) => {
    const pixel = devicePixelRatio || 1;
    el.style.transform = `translateY(${Math.round((geometry.most() - height) * pixel) / pixel}px)`;
  };
  // `fit` is asked once the sheet is no longer held, so it can read the sheet as it stands.
  const release = (fit: () => number) => {
    settling?.cancel(); settling = undefined;
    delete el.dataset.sheetHeld;
    el.style.height = `${Math.round(fit())}px`;
    el.style.transform = '';
  };
  const hold = (height: number) => {
    settling = undefined;
    el.getAnimations().forEach(animation => animation.cancel());
    el.dataset.sheetHeld = '';
    el.style.height = `${geometry.most()}px`;
    follow(height);
  };
  const settle = (height: number, then: () => void = () => {}, fit: () => number = () => height, speed?: number) => {
    if (reducedMotion()) {
      release(fit);
      then();
      return;
    }
    const from = shown();
    hold(from);
    const motion = el.animate([{ transform: el.style.transform }, { transform: `translateY(${geometry.most() - height}px)` }],
      { ...letGo(height - from, speed === undefined ? undefined : Math.sign(height - from) * speed), fill: 'forwards' });
    settling = motion;
    void motion.finished.then(() => {
      motion.cancel();
      if (settling !== motion) return;
      release(fit);
      then();
    }, () => {});
  };
  return { shown, hold, follow, settle,
    stop: () => release(geometry.stand),
  };
}

/**
 * The live sheet closes immediately; an inert copy completes the same departure for both surfaces. `unname` takes from
 * the copy what makes the surfaces it carries findable, as crossfade's does.
 */
export function leaveSheet(el: HTMLElement, speed?: number, unname?: (copy: HTMLElement) => void) {
  if (!el.isConnected || typeof el.animate !== 'function' || document.hidden) return;
  // Read the original and its motion tokens before appending the picture invalidates page style.
  const style = getComputedStyle(el), from = style.transform, opacity = style.opacity;
  const below = Number.parseFloat(style.bottom) || 0;
  const left = innerHeight - el.getBoundingClientRect().top;
  const reduced = reducedMotion();
  const timing = reduced ? { duration: duration('fast'), easing: easing('out') }
    : speed === undefined ? { duration: duration('base'), easing: easing('in') } : letGo(left, -speed);
  const { copy: ghost, place } = stillCopy(el);
  // These identify live surfaces, including in document-wide :has selectors. The copy is only their picture.
  ghost.removeAttribute('data-sheet');
  ghost.removeAttribute('data-coordinator-panel');
  unname?.(ghost);
  // React removes the live sheet in this commit. Removing its focused control can flush layout;
  // attach the picture afterwards, before the next paint, so that flush does not lay out both trees.
  queueMicrotask(() => {
    document.body.append(ghost);
    place();
    const motion = ghost.animate(reduced ? [{ opacity }, { opacity: 0 }]
      : [{ transform: from === 'none' ? 'translateY(0)' : from }, { transform: `translateY(calc(100% + ${below}px))` }],
      { ...timing, fill: 'forwards' });
    void motion.finished.then(() => ghost.remove(), () => ghost.remove());
  });
}

/** How far a slow pull must have gone to close a sheet, so that one standing at its least is not closed by a nudge. */
const LET_GO = 48;

/** Where a sheet let go goes: whole, away, or resting at a height between (px from the screen's foot). */
export type SheetLanding = { to: "whole" } | { to: "away" } | { to: "rest"; height: number };

/**
 * Where a sheet let go at `height` (px tall, taken from `from`) at `speed` (px/ms, up is positive) goes, one rule for
 * every sheet: carried on by the finger's speed a little, it goes whole near the screen's top or on a clear flick up,
 * away on a clear flick down or under the least it can stand at (and a nudge's room under where it was taken from),
 * else it rests where it comes to. `rests`: the least and most it may stand at below whole; a surface that is whole
 * or nothing (a phone's diff) has none, and where a sheet would rest, it goes away.
 */
export function sheetLanding({ height, from, speed, screen, rests }: {
  height: number; from: number; speed: number; screen: number; rests: readonly [number, number] | null;
}): SheetLanding {
  const projected = height + speed * 160;
  if (speed > FLICK || projected >= screen * 0.9) return { to: "whole" };
  if (!rests || speed < -FLICK || projected <= Math.min(rests[0], from - LET_GO)) return { to: "away" };
  return { to: "rest", height: Math.min(rests[1], Math.max(rests[0], projected)) };
}

/**
 * A press on a sheet (sheet-press) as its hand: it follows the finger (past the screen's top it gives way slowly), and
 * let go it goes where sheetLanding says (`land`, with the finger's speed); a press taken back (a second finger, the
 * browser) puts it back where it stood (`stand`), then does what the sheet does back at rest (`rested`). `pull`: a
 * press from what the sheet shows rather than its grip.
 */
export function sheetHand(motion: ReturnType<typeof sheetMotion>, { pull, stand, rests, land, rested = () => {} }: {
  pull: boolean; stand: () => number; rests: () => readonly [number, number] | null; land: (landing: SheetLanding, speed: number) => void;
  rested?: () => void;
}): SheetPress {
  return {
    pull,
    take: () => {
      const from = motion.shown(), stood = stand();
      let height = from;
      motion.hold(from);
      return {
        follow: (rise) => {
          const raw = from + rise;
          height = raw > innerHeight ? innerHeight + (raw - innerHeight) / 4 : Math.max(0, raw);
          motion.follow(height);
        },
        release: (speed) => {
          if (speed === undefined) return motion.settle(stood, rested, stand);
          land(sheetLanding({ height, from, speed, screen: innerHeight, rests: rests() }), speed);
        },
      };
    },
  };
}
