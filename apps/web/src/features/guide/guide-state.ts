import { deviceValue, jsonCodec } from "@/lib/device-storage";

/**
 * How far this browser is through the getting-started guide: started (at the moment it began, so a request sent
 * afterwards is known as this guide's first one), got as far as the person's turn (with the steps read and put away
 * since: `seen`), or over (finished or closed). Nothing stored is a browser that has never seen it.
 */
export type GuideStage = { stage: "started"; at: number; seen: readonly string[] } | { stage: "turn"; seen: readonly string[] } | { stage: "done" };

const check = (value: unknown): GuideStage | null => {
  if (typeof value !== "object" || value === null) return null;
  const { stage, at, seen } = value as { stage?: unknown; at?: unknown; seen?: unknown };
  const read = Array.isArray(seen) ? seen.filter((id): id is string => typeof id === "string") : [];
  if (stage === "started" && typeof at === "number") return { stage, at, seen: read };
  if (stage === "turn") return { stage, seen: read };
  return stage === "done" ? { stage } : null;
};
export const guideStage = deviceValue<GuideStage | null>("alpacawork.guide", jsonCodec<GuideStage | null>(check), null);
/** Ends the guide for good on this browser: closed by hand, or read to its end. */
export const closeGuide = () => { guideStage.set({ stage: "done" }); };
/** Settings' "Show again": the guide starts over from its first step. */
export const restartGuide = () => { guideStage.set({ stage: "started", at: Date.now(), seen: [] }); };
/** A step read and put away ("Got it"): the guide goes on to the next one that holds. */
export const putAway = (id: string) => {
  const stage = guideStage.get();
  if (stage && stage.stage !== "done" && !stage.seen.includes(id)) guideStage.set({ ...stage, seen: [...stage.seen, id] });
};
