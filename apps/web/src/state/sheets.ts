import { deviceValue } from "@/lib/device-storage";

/**
 * On a phone the reader is a sheet from the bottom: the same one sheet whatever it shows, a task named in it
 * showing in it as the reader's next step. It stands at the share of the screen the person last left it at,
 * kept on this device; pulled to the top it is the whole screen until it is let down again (the reader's `whole`).
 */
/** At first a sheet stands at two thirds of the screen. */
export const FIRST_SHARE = 2 / 3;
/** A share a finger can leave a sheet at: lower closes it, higher makes it whole. */
export const SHARE_RANGE = [0.25, 0.85] as const;
export const sheetShare = deviceValue("alpacawork.sheetHeight", {
  read: (raw) => { const value = Number(raw); return value >= SHARE_RANGE[0] && value <= SHARE_RANGE[1] ? value : null; },
  write: String,
}, FIRST_SHARE);

export function setSheetShare(share: number) {
  sheetShare.set(Math.min(SHARE_RANGE[1], Math.max(SHARE_RANGE[0], share)));
}
