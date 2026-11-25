import { countUse } from '@/features/telemetry/count';
import { useEffect } from "react";
import { flushSync } from "react-dom";
import { isComposingKey } from "@/components/ui/composing";
import { openSettings, useDialogStore } from "@/state/dialog-store";
import { isSearchShown, useViewStore } from "@/state/view-store";
import { closeTopReader, closeView } from "@/state/history-step";
import { focusCoordinator as focusComposer, leaveCoordinator as leaveComposer, focusReader } from "@/features/coordinator/editor/draft";
import { useEscapeLayer } from "@/lib/escape-layer";
import { cancelPendingSearch, focusSearchInput } from "./search-ref";

/** Page-wide shortcuts; the shared Escape listener calls the lowest reading layer here. */
export function useGlobalShortcuts() {
  useEscapeLayer(true, 0, (event) => {
    const dialogs = useDialogStore.getState();
    const view = useViewStore.getState();
    const inComposer = event.target instanceof Element && !!event.target.closest("[data-one-input-area]");
    if (dialogs.dialog?.kind === "input") { dialogs.close(); return true; }
    if (dialogs.dialog) return false;
    if (inComposer) leaveComposer();
    else if (view.reader.open) closeTopReader();
    else if (view.selected) view.closeDetail();
    else if (isSearchShown(view)) {
      cancelPendingSearch();
      view.toggleSearch();
      requestAnimationFrame(() => {
        const toggle = document.querySelector<HTMLElement>("[data-search-toggle]");
        if (toggle?.getClientRects().length) toggle.focus();
      });
    } else return false;
    return true;
  });
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isComposingKey(event)) return;
      const dialogs = useDialogStore.getState();
      const view = useViewStore.getState();
      const inComposer = event.target instanceof Element && !!event.target.closest("[data-one-input-area]");
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "j" && !dialogs.dialog && view.reader.open) {
        event.preventDefault();
        countUse('key.focus');
        if (inComposer) focusReader(); else focusComposer();
        return;
      }
      // ⌘, (Ctrl+, off a Mac) opens the settings at their usual tab, from an input too, as ⌘K does; already open, they stay as they are.
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key === ",") {
        event.preventDefault();
        if (dialogs.dialog?.kind === "settings") return;
        countUse('key.settings');
        if (!dialogs.dialog) return openSettings();
        dialogs.close();
        // As below: open after the closing dialog has handed focus back to its opener.
        setTimeout(() => setTimeout(() => openSettings()));
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key === "k") {
        event.preventDefault();
        countUse('key.search');
        const focusSearch = () => { flushSync(() => useViewStore.getState().openSearch()); focusSearchInput(); };
        // A diff or a file read in the list's place gives it back first: the search stands over the list.
        if (useViewStore.getState().view && !dialogs.dialog) {
          // Its closing is a step back in history: focus the search once it is gone and has handed its focus back.
          const stop = useViewStore.subscribe(state => { if (!state.view) { stop(); setTimeout(focusSearch); } });
          closeView();
          return;
        }
        if (!dialogs.dialog) return focusSearch();
        dialogs.close();
        // The closing dialog hands focus back to its opener in a timeout of its
        // own, scheduled when it unmounts; focus the search box after that.
        setTimeout(() => setTimeout(focusSearch));
      }
    };
    // The other shortcuts keep their document capture behavior.
    document.addEventListener("keydown", onKey, { capture: true });
    return () => document.removeEventListener("keydown", onKey, { capture: true });
  }, []);
}
