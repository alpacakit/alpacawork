import { startTransition, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "@/components/ui/icon";
import { faceOf, isSearchShown, useViewStore } from "@/state/view-store";
import { cn } from "@/lib/utils";
import { registerSearchClose } from "./search-ref";

/**
 * The search box (⌘K): in the app bar when it fits; otherwise the bar's button opens its row.
 * A search shows results in the list's place; the groups of the list stand in for a state filter.
 */
export function SearchField({ className }: { className?: string }) {
  const { t } = useTranslation("chrome");
  const query = useViewStore((state) => state.query);
  const { setQuery } = useViewStore.getState();
  const [draft, setDraft] = useState(query);
  const composing = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancel = () => { if (timer.current !== null) clearTimeout(timer.current); timer.current = null; };
  const settle = (value: string) => {
    cancel();
    // The index cannot search yet. Record the edit now so the initial URL read
    // does not replace it if the first snapshot arrives during the debounce.
    if (!useViewStore.getState().navigationReady) { setQuery(value); return; }
    timer.current = setTimeout(() => {
      timer.current = null;
      startTransition(() => setQuery(value));
    }, 150);
  };
  useEffect(() => { if (!composing.current) { cancel(); setDraft(query); } }, [query]);
  // The screen's face changing (Use, Analysis, Settings, today's marks, a task opened from the analysis, a notification,
  // Back or Forward: every one goes through the store's face, `faceOf`) drops an edit not yet applied, so a search typed
  // just before cannot show its results over the face just chosen.
  // A conversion under way when it changes is dropped too: its confirmation then runs no search.
  const dropped = useRef(false);
  useEffect(() => useViewStore.subscribe((state, before) => {
    if (faceOf(state) === faceOf(before) || timer.current === null && !composing.current) return;
    cancel();
    if (composing.current) dropped.current = true;
    setDraft(state.query);
  }), []);
  useEffect(() => cancel, []);
  return (
    <label className={cn("flex h-control-md min-w-0 items-center gap-2 rounded-md border border-lit-line px-2 text-muted focus-within:border-ink", className)}>
      <Icon name="search" />
      <input
        ref={(input) => registerSearchClose(input, () => { cancel(); setDraft(""); })}
        data-search-input
        type="search"
        value={draft}
        onChange={(event) => {
          const value = event.target.value;
          setDraft(value);
          if (!composing.current && !(event.nativeEvent as InputEvent).isComposing) settle(value);
        }}
        onCompositionStart={() => { composing.current = true; dropped.current = false; cancel(); }}
        onCompositionEnd={(event) => {
          composing.current = false;
          if (dropped.current) { dropped.current = false; setDraft(useViewStore.getState().query); return; }
          setDraft(event.currentTarget.value); settle(event.currentTarget.value);
        }}
        placeholder={t("toolbar.searchPlaceholder")}
        aria-label={t("toolbar.searchLabel")}
        className="h-control-sm w-full min-w-0 border-0 bg-transparent px-0.5 py-px text-sm text-ink outline-none"
      />
      <span className="flex-none text-xs whitespace-nowrap text-soft narrow:hidden">⌘ K</span>
    </label>
  );
}

/** The search row is behind the compact bar's button, so the list starts higher; a search keeps it shown. */
export function NarrowSearchRow() {
  const shown = useViewStore(isSearchShown);
  if (!shown) return null;
  return <div data-search-row className="hidden flex-none pb-2 compactbar:flex"><SearchField className="h-11 flex-1" /></div>;
}
