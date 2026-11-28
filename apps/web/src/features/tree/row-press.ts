/** A list row's own controls (a time's tip, a fold): a press on one is theirs, never the row's. */
export const ROW_CONTROLS = "button, a, [role=button]";

/**
 * Whether a press on `target` opens a list row's task: its title, or any other part of the row's words that is not a
 * control of its own. A popup that stays open while a task opens (the input's # list) asks this, as the row decides it.
 */
export function pressOpensRow(target: Pick<Element, "closest">): boolean {
  return !!target.closest("[data-read]") || (!!target.closest("[data-row-label]") && !target.closest(ROW_CONTROLS));
}
