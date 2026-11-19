/**
 * A still copy of the reader (lib/motion.ts `stillCopy`) drawn as it is, which is no reader: nothing finds or names it
 * as one. The crossfade's copy, the answered card's and the phone sheet's going down (TaskSheet.tsx) are made alike.
 */
export function unnameReader(copy: HTMLElement) {
  copy.removeAttribute("data-reader-mode");
  copy.removeAttribute("aria-label");
}
