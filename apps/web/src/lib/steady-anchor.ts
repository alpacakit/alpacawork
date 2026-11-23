/** What a popover is placed against: an element, or a virtual one that names the element it stands for. */
export type Measurable = { getBoundingClientRect(): DOMRect; contextElement?: Element };
type Box = { x: number; y: number; width: number; height: number };

/**
 * The anchor an open popover follows. The popover's place is decided when it opens, against what opened it; after that
 * it follows that element only where the element moves as a whole (the page scrolls, the keyboard pushes the input up,
 * something above it grows). When the element itself changes size (its label grows to a longer name, which can also
 * push it left or onto another line), the popover stays where it is, so what the person was
 * about to press under it does not move away.
 *
 * `read` gives the element as it is now; `reset` forgets the place, so the next opening takes it afresh.
 */
export function steadyAnchor(read: () => Measurable | null | undefined) {
  let held: Box | null = null;
  let last: Box | null = null;
  return {
    get contextElement(): Element | undefined {
      const source = read();
      return source instanceof Element ? source : source?.contextElement;
    },
    getBoundingClientRect(): DOMRect {
      const now = read()?.getBoundingClientRect();
      if (now) {
        held = follow(held, last, now);
        last = box(now);
      }
      return rect(held ?? { x: 0, y: 0, width: 0, height: 0 });
    },
    reset() { held = null; last = null; },
  };
}

/** Where the anchor stands now: moved by the element's move when its size is the same, left where it was when not. */
export function follow(held: Box | null, last: Box | null, now: Box): Box {
  if (!held || !last) return box(now);
  if (now.width !== last.width || now.height !== last.height) return held;
  return { x: held.x + now.x - last.x, y: held.y + now.y - last.y, width: held.width, height: held.height };
}

const box = ({ x, y, width, height }: Box): Box => ({ x, y, width, height });
const rect = ({ x, y, width, height }: Box) => ({
  x, y, width, height, left: x, top: y, right: x + width, bottom: y + height, toJSON() { return box(this); },
}) as DOMRect;
