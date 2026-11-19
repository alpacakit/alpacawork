/** Focus the search box currently drawn by the container query. */
export function focusSearchInput() {
  const inputs = document.querySelectorAll<HTMLInputElement>("[data-search-input]");
  for (const input of inputs) {
    if (input.getClientRects().length) { input.focus(); return; }
  }
}

const pending = new WeakMap<HTMLInputElement, () => void>();

/** The field owns its delayed edit; closing search tells each mounted field to discard it. */
export function registerSearchClose(input: HTMLInputElement | null, close: () => void) {
  if (input) pending.set(input, close);
}

export function cancelPendingSearch() {
  for (const input of document.querySelectorAll<HTMLInputElement>("[data-search-input]")) pending.get(input)?.();
}
