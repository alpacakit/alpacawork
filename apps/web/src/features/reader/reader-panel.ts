import { create } from "zustand";
import { useViewStore } from "@/state/view-store";

/** The reader has one related-task panel. Its kind, place and return focus belong here, across task navigation. */
export type ReaderPanelKind = "family" | "dependencies";
type PanelState = {
  kind: ReaderPanelKind | null;
  entries: Partial<Record<ReaderPanelKind, HTMLElement>>;
  slot: HTMLElement | null;
};
export const useReaderPanel = create<PanelState>(() => ({ kind: null, entries: {}, slot: null }));
export const hideReaderPanel = () => useReaderPanel.setState({ kind: null });
export const toggleReaderPanel = (kind: ReaderPanelKind) =>
  useReaderPanel.setState(state => ({ kind: state.kind === kind ? null : kind }));

/** Stable refs; only the element that owns a place can release it when a reader face goes away. */
export const panelEntry = Object.fromEntries((["family", "dependencies"] as const).map(kind => [kind, (element: HTMLElement | null) => {
  if (element) useReaderPanel.setState(state => ({ entries: { ...state.entries, [kind]: element } }));
  return () => {
    if (useReaderPanel.getState().entries[kind] === element)
      useReaderPanel.setState(state => { const entries = { ...state.entries }; delete entries[kind]; return { entries }; });
  };
}])) as Record<ReaderPanelKind, (element: HTMLElement | null) => () => void>;
export const panelSlot = (element: HTMLElement | null) => {
  useReaderPanel.setState({ slot: element });
  return () => { if (useReaderPanel.getState().slot === element) useReaderPanel.setState({ slot: null }); };
};
useViewStore.subscribe((view, before) => { if (before.reader.open && !view.reader.open) hideReaderPanel(); });

/** Scroll positions live for the page, by list and its subject; the tree keeps its folds separately. */
const positions = new Map<string, { scroll: number }>();
export function panelPosition(kind: ReaderPanelKind, subject: string) {
  const key = `${kind}:${subject}`;
  let position = positions.get(key);
  if (!position) positions.set(key, position = { scroll: 0 });
  return position;
}
export function forgetPanelPositions() { positions.clear(); }
