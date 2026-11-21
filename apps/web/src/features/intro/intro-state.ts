import { create } from "zustand";
import { deviceValue } from "@/lib/device-storage";

/** Whether this browser has closed the introduction (read to its end, or skipped): it never opens by itself again. */
export const introSeen = deviceValue("alpacawork.introSeen", { read: (raw) => raw === "1" || null, write: () => "1" }, false);
/**
 * Whether the introduction is open. It is its own surface, not the page's one open dialog (dialog-store): opened from
 * the settings it stands over them, so the settings stay as they were, with what was being written in them.
 */
export const useIntro = create<{ open: boolean }>(() => ({ open: false }));
/** Opens the introduction: by itself the first time (startsIntro), and from the welcome and the settings after that. */
export const openIntro = () => useIntro.setState({ open: true });
/** Closes it, read to its end or not, and remembers that on this browser. */
export const closeIntro = () => { introSeen.set(true); useIntro.setState({ open: false }); };
