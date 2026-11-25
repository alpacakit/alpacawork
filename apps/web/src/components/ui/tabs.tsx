import * as React from "react";
import { cn } from "@/lib/utils";
import { duration, easing, reducedMotion } from "@/lib/motion";
import { sizeObserver } from "@/lib/surface";
import { Tabs as TabsPrimitive } from "radix-ui";

/**
 * The one look of a row of tabs, here and under a task's title (ReaderEntries): quiet words, the tab shown in ink and
 * bold on a grey rounded ground. That ground is one mark for the row (TabMarker) which slides from the tab left to the
 * tab chosen, so the eye follows the choice; a pointer over a tab only inks it, so it is never taken for the one shown.
 * The row never wraps: where it does not fit it scrolls sideways.
 */
export const TAB_ROW = "relative flex flex-none items-center gap-1 overflow-x-auto px-1 [scrollbar-width:none]";

/**
 * A tab, whose state is read from what it says to a screen reader: the tab shown (`aria-selected` in a tab list,
 * `aria-current` among the reader's panes) is bold ink, and a button whose panel is open (`aria-expanded`) is ink.
 * The area a finger presses reaches past what is drawn, above and below.
 */
export const TAB = ["relative inline-flex h-7 flex-none cursor-pointer items-center gap-1.5 rounded-md px-2 text-sm whitespace-nowrap text-muted",
  "after:absolute after:-inset-x-0.5 after:-inset-y-1.5 after:content-[''] narrow:h-8 narrow:after:-inset-y-2 hover:text-ink",
  "aria-expanded:text-ink aria-selected:font-semibold aria-selected:text-ink aria-[current=page]:font-semibold aria-[current=page]:text-ink"].join(" ");

/** A count beside a tab's name, on a chip; on the tab shown it takes the surface's own ground, off the mark's grey. */
export const TAB_COUNT = "rounded-full bg-hover px-1.5 py-0.5 text-xs tabular-nums group-aria-[current=page]:bg-lit";

/**
 * A tab's name, as wide as its bold self whether it is shown or not, so marking one never moves the tabs beside it:
 * the bold self is drawn unseen in the same place, as generated content with no words of its own for a screen reader
 * or a copy. A text's line box is centred by its font's ascent and descent, which differ by device: trimmed to the
 * capitals and the baseline, it is what the eye reads as the text, on any font.
 */
export function TabLabel({ children }: { children: string }) {
  return <span data-text={children} className="inline-grid after:invisible after:font-semibold after:content-[attr(data-text)_/_''] after:[grid-area:1/1] after:[text-box:trim-both_cap_alphabetic]">
    <span className="[grid-area:1/1] [text-box:trim-both_cap_alphabetic]">{children}</span>
  </span>;
}

/**
 * The grey ground under the tab shown, the first thing in its row. It finds that tab with `current` and stands under
 * it; when another tab is chosen (a press, a key, or the screen choosing), it slides there from where it is drawn
 * (mid-way, if it was still sliding) and takes its width, over the motion step for a move within its place. Only its
 * transform moves. It is placed at once, not slid, the first time, when a tab's size changes, and under reduced motion.
 */
export function TabMarker({ current }: { current: string }) {
  const marker = React.useRef<HTMLSpanElement>(null);
  React.useLayoutEffect(() => {
    const self = marker.current, row = self?.parentElement;
    if (!self || !row) return;
    let shown: HTMLElement | null = null, at = { x: 0, y: 0, width: 0, height: 0 }, sliding: Animation | null = null;
    const drawn = () => {
      if (sliding?.playState !== "running") return at;
      const matrix = new DOMMatrix(getComputedStyle(self).transform);
      return { x: matrix.e, width: matrix.a * at.width };
    };
    const place = (slide: boolean) => {
      const next = row.querySelector<HTMLElement>(current);
      self.hidden = !next;
      if (!next) { shown = null; return; }
      // The whole box: a tab that only grows taller (a row of larger tabs on a phone) or moves down a line is placed again.
      const to = { x: next.offsetLeft, y: next.offsetTop, width: next.offsetWidth, height: next.offsetHeight }, y = to.y;
      if (shown === next && to.x === at.x && to.y === at.y && to.width === at.width && to.height === at.height) return;
      const from = slide && shown && shown !== next && !reducedMotion() ? drawn() : null;
      sliding?.cancel();
      sliding = null;
      shown = next; at = to;
      self.style.width = `${to.width}px`;
      self.style.height = `${to.height}px`;
      self.style.transform = `translate(${to.x}px, ${y}px)`;
      if (from && to.width) sliding = self.animate([
        { transform: `translate(${from.x}px, ${y}px) scaleX(${from.width / to.width})` },
        { transform: `translate(${to.x}px, ${y}px)` },
      ], { duration: duration("base"), easing: easing("out") });
    };
    const sized = sizeObserver(row, () => place(false));
    const watch = () => { sized.disconnect(); sized.observe(row); for (const child of row.children) sized.observe(child); };
    const changed = new MutationObserver((records) => {
      if (records.some(record => record.type === "childList")) watch();
      place(true);
    });
    changed.observe(row, { subtree: true, childList: true, attributes: true, attributeFilter: ["aria-current", "aria-selected"] });
    watch();
    place(false);
    return () => { changed.disconnect(); sized.disconnect(); sliding?.cancel(); };
  }, [current]);
  return <span ref={marker} aria-hidden data-tab-marker className="pointer-events-none absolute top-0 left-0 origin-left rounded-md bg-tab-shown" />;
}

/** shadcn's Tabs (Radix), drawn as the row above. */
function Tabs({
  className,
  orientation = "horizontal",
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      data-orientation={orientation}
      className={cn("flex flex-col", className)}
      {...props}
    />
  );
}

/** Over a rule, the room under the tabs as the room above them. */
function TabsList({ className, children, ...props }: React.ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={cn(TAB_ROW, "border-b border-line py-2", className)}
      {...props}
    >
      <TabMarker current='[role="tab"][aria-selected="true"]' />
      {children}
    </TabsPrimitive.List>
  );
}

/** Its name is a string, so it keeps its width when shown (TabLabel). */
function TabsTrigger({ className, children, ...props }: Omit<React.ComponentProps<typeof TabsPrimitive.Trigger>, "children"> & { children: string }) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(TAB, className)}
      {...props}
    >
      <TabLabel>{children}</TabLabel>
    </TabsPrimitive.Trigger>
  );
}

function TabsContent({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn("outline-none", className)}
      {...props}
    />
  );
}

export { Tabs, TabsList, TabsTrigger, TabsContent };
