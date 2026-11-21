import { deviceValue } from "@/lib/device-storage";
import { useDialogStore } from "@/state/dialog-store";

/** Whether this browser has closed the introduction (read to its end, or skipped): it never opens by itself again. */
export const introSeen = deviceValue("alpacawork.introSeen", { read: (raw) => raw === "1" || null, write: () => "1" }, false);
/** Opens the introduction: by itself the first time (startsIntro), and from the welcome and the settings after that. */
export const openIntro = () => useDialogStore.getState().open("intro");
