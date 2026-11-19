/** The URL's event in the reading column, including a folded report. */
export function readerEventElement(area: ParentNode, key: string): HTMLElement | null {
  const escaped = CSS.escape(key);
  return area.querySelector<HTMLElement>(`[data-folded-report="${escaped}"]`)
    ?? area.querySelector<HTMLElement>(`li[data-report-key="${escaped}"]`);
}
