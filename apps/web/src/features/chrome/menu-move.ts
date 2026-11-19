import type { KeyboardEvent } from "react";

/** A menu's keys: the arrows go round the items it can press, Home and End to its ends; composing text keeps them. */
export function moveMenuFocus(event: KeyboardEvent<HTMLDivElement>) {
  if (event.nativeEvent.isComposing) return;
  const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"], [role="menuitemradio"]')]
    .filter(item => !item.disabled);
  const at = items.indexOf(document.activeElement as HTMLButtonElement);
  if (event.key === "ArrowDown") { event.preventDefault(); items[(at + 1) % items.length]?.focus(); }
  if (event.key === "ArrowUp") { event.preventDefault(); items[(at - 1 + items.length) % items.length]?.focus(); }
  if (event.key === "Home") { event.preventDefault(); items[0]?.focus(); }
  if (event.key === "End") { event.preventDefault(); items.at(-1)?.focus(); }
}
