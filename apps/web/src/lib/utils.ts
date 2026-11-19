import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/** The size steps named in styles.css that tailwind-merge does not know by
 *  itself: without them a caller's `min-h-control-lg` would not replace a
 *  part's `min-h-control-sm`, and both would stay on the element. */
const controlHeights = ["control-xs", "control-sm", "control-md", "control-lg"];
const twMerge = extendTailwindMerge({
  extend: {
    // The head line's spacings (styles.css, Head line), so a caller's `right-3` replaces a part's `right-window`; a pane's
    // corner (tokens.css), so a caller's `rounded-none` replaces `rounded-pane`.
    theme: { container: ["dialog", "dialog-wide"], spacing: ["window", "head", "head-room"], radius: ["pane"] },
    classGroups: {
      h: [{ h: controlHeights }],
      // The app bar's and a head row's heights (styles.css, Head line) are min-height steps too.
      "min-h": [{ "min-h": [...controlHeights, "bar", "head"] }],
      "max-h": [{ "max-h": controlHeights }],
      // The steps tailwind-merge does not have (styles.css: md, a stamp's seal): sizes, not colours, so `text-ink` or
      // `text-done` beside them stays and a caller's `text-sm` replaces them.
      "font-size": [{ text: ["md", "seal"] }],
      // A surface's edge and shadow (styles.css), so a caller's `shadow-none` or `border-0` replaces them.
      "border-w": [{ border: ["hairline"] }],
      "border-w-t": [{ "border-t": ["hairline"] }],
      shadow: [{ shadow: ["float"] }],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
