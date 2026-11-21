import { deviceValue } from "@/lib/device-storage";
import { useDialogStore } from "@/state/dialog-store";

/**
 * Whether this browser is past the introduction: it was shown here and went away (read to its end, skipped, or closed
 * by anything else), or the person was found already at work. It never opens by itself again.
 */
export const introSeen = deviceValue("alpacawork.introSeen", { read: (raw) => raw === "1" || null, write: () => "1" }, false);
/**
 * Opens the introduction: by itself the first time (startsIntro), and from the welcome and the project's menu after that.
 * It is one of the page's dialogs (dialog-store), so it opens, closes and gives way as every dialog does.
 */
export const openIntro = () => useDialogStore.getState().open("intro");
