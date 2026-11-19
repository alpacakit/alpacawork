import { useEffect } from "react";

const KEYS = ["Tab", "Enter", " ", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];
/** Keys that move the focus or leave from anywhere; in a field the others are writing (a line, a space, the caret). */
const LEAVING = ["Tab", "Escape"];
const writing = (target: EventTarget | null) =>
  target instanceof Element && !!target.closest("textarea, [contenteditable]:not([contenteditable=false]), input:not([type=checkbox], [type=radio], [type=button], [type=submit], [type=reset], [type=range], [type=color], [type=file], [type=image])");

export function markKeyboardInput() {
  document.documentElement.dataset.input = "keyboard";
}

/**
 * `<html data-input="pointer|keyboard">`: focus rings show only for keyboard
 * use (styles.css). Mounted once, by the shell.
 */
export function useInputMode() {
  useEffect(() => {
    document.documentElement.dataset.input = "pointer";
    return followInput(document);
  }, []);
}

/** The keys and presses in `at` (the app's document, or a window of its own) say which is in use on the app's root. */
export function followInput(at: Document) {
  const root = document.documentElement;
  const pointer = () => (root.dataset.input = "pointer");
  const key = (event: KeyboardEvent) => {
    // Enter in the coordinator's input sends, and the focus then goes back to its line: that is not keyboard use.
    if (KEYS.includes(event.key) && (LEAVING.includes(event.key) || !writing(event.target))) markKeyboardInput();
  };
  at.addEventListener("pointerdown", pointer, true);
  at.addEventListener("keydown", key, true);
  return () => {
    at.removeEventListener("pointerdown", pointer, true);
    at.removeEventListener("keydown", key, true);
  };
}
