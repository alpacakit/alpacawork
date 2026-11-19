import { NARROW_QUERY, useViewStore } from "@/state/view-store";
import { fitPhoneSheetToLowerHalf } from "./PhoneSheet";

/** Both kinds of conversation task links open through the same layout intent. */
export function followTask(id: string) {
  const phone = matchMedia(NARROW_QUERY).matches;
  if (phone) fitPhoneSheetToLowerHalf();
  useViewStore.getState().openTask(id, { reader: true, whole: phone ? true : undefined });
}
