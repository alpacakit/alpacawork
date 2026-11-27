import { useViewStore } from "@/state/view-store";
import { automationsHome, type AutomationsPane } from "./place";

/** Where the automations face was last left: coming back finds it so. */
let left = automationsHome;
useViewStore.subscribe(state => { if (state.automations) left = state.automations; });

/** Opens the automations face where it was last left. */
export const openAutomations = () => useViewStore.getState().showAutomations(left);

/** Shows the automations face's table or its runs. */
export const showAutomationsTab = (tab: AutomationsPane) => useViewStore.getState().showAutomations({ tab });

/**
 * Opens one automation in the reader's window over the face shown (the home's list stays under it, as under a task),
 * on what it does unless a pane is named.
 */
export const openAutomation = (id: string, pane?: "about" | "log" | "code") => useViewStore.getState().openAutomation(id, pane);
