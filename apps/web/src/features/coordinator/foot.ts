import { NARROW_QUERY } from "@/state/view-store";

export const voiceAvailable = () => typeof document !== "undefined" && !!document.querySelector('meta[name="alpacawork-voice"]');

/** An answer's first sentence, as plain words for its one line while the conversation is folded. */
export function firstSentence(answer: string): string {
  const plain = answer.replace(/```[\s\S]*?```/g, " ").replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*_`>#|]/g, "")
    .split("\n").map(line => line.replace(/^\s*(?:[-+]|\d+\.)\s+/, "").trim()).filter(Boolean).join(" ");
  // Ends at a full-width 。．！？ (U+3002, U+FF0E, U+FF01, U+FF1F), or at . ! ? before a space or the end.
  return /^.*?(?:[\u3002\uff0e\uff01\uff1f]|[.!?](?=\s|$))/.exec(plain)?.[0] ?? plain;
}

/**
 * Whether the coordinator goes down by itself, unasked: on a phone, where it covers what is read, a tap on what it
 * stands over and a message sent each take it one step down. On a computer it stands beside what is read and stays as
 * it is: another Task opened from the list or from a report, or a message sent, leaves the conversation and the
 * input up; only its own buttons and Esc put it down.
 */
export const goesDownByItself = () => matchMedia(NARROW_QUERY).matches;

/** What stands over the coordinator's foot: the conversation's notice. */
export const OVER_FOOT = "[data-coordinator-pill]";
/** A control of how the input sends, wherever it stands (the reader's pin): pressing it is turning to the input. */
export const INPUT_OWN = "[data-input-own]";

/**
 * How tall `outer` is with `inner` (what scrolls in it, inside columns of it) at its own least height: each part beside
 * them at the height it needs, with each column's padding and border. Read from the parts, not from `outer` as drawn:
 * squeezed under its least, the columns between them are drawn smaller than what they hold, and so is a part that
 * scrolls (the input's files, a row scrolled sideways), which needs what it holds, up to its own max-height. Each part
 * read is handed to `read` (to be watched: one changing size inside `outer`, as a list folded, need not resize `outer`).
 */
export function leastHeight(outer: HTMLElement, inner: HTMLElement, read?: (part: Element) => void) {
  const px = (value: string) => Number.parseFloat(value) || 0;
  let least = px(getComputedStyle(inner).minHeight);
  for (let at = inner; at !== outer && at.parentElement; at = at.parentElement) {
    const parent = at.parentElement, sides = getComputedStyle(parent);
    least += px(sides.paddingTop) + px(sides.paddingBottom) + px(sides.borderTopWidth) + px(sides.borderBottomWidth);
    for (const part of parent.children) {
      const style = getComputedStyle(part);
      if (part === at || style.position === "absolute" || style.position === "fixed") continue;
      read?.(part);
      const holds = Math.min(part.scrollHeight + px(style.borderTopWidth) + px(style.borderBottomWidth), px(style.maxHeight) || Infinity);
      least += Math.max(part.getBoundingClientRect().height, holds) + px(style.marginTop) + px(style.marginBottom);
    }
  }
  return least;
}
