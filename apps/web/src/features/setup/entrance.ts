import { create } from "zustand";
import { replaceStep } from "@/lib/history";

/**
 * The setup stands in place of the page while the address is /welcome (where the server sends a new workspace until
 * its setup is finished). Finishing writes the page's address and draws the page in the same document, on the
 * workspace already read: no reload, and nothing blank or half drawn between.
 */
export const useEntrance = create<{ setup: boolean }>(() => ({ setup: location.pathname === "/welcome" }));
export const leaveSetup = (url: URL) => {
  replaceStep(history.state, url);
  useEntrance.setState({ setup: false });
};
