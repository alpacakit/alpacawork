import { deviceValue, jsonCodec, useDeviceValue } from "@/lib/device-storage";

/**
 * How a diff or a file is read, as its reader chose it, kept on the device: side by side or one above the other (null:
 * as the frame's width has it, readsSideBySide), and a document by its words or by its lines as written.
 */
export type LookChoice = { split: boolean | null; source: boolean };
const look = deviceValue<LookChoice>("alpacawork.viewerLook", jsonCodec(kept => {
  const { split, source } = (kept ?? {}) as Partial<LookChoice>;
  return typeof source === "boolean" && (split === null || typeof split === "boolean") ? { split, source } : null;
}), { split: null, source: false });
export function chooseLook(change: Partial<LookChoice>) { look.set({ ...look.get(), ...change }); }
export const useLookChoice = () => useDeviceValue(look);
