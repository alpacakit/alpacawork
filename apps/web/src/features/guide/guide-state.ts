import { deviceValue, jsonCodec, type DeviceValue } from "@/lib/device-storage";
import { useViewStore } from "@/state/view-store";
import type { GuideScreen } from "./guide-definition";

/**
 * How far this browser is through a screen's getting-started guide: started (at the moment it began, so a request sent
 * afterwards is known as this guide's first one; `intro` while its first step is shown again whatever the work, until
 * another step holds), got as far as the person's turn (with the steps read and put away
 * since: `seen`), or over (`read` to its end, or closed by hand). `finished`: the Tasks the person pressed Done on since it began. Nothing stored is a browser that has never seen it.
 */
export type GuideStage = { stage: "started"; at: number; seen: readonly string[]; intro?: true; finished?: readonly string[] }
  | { stage: "turn"; seen: readonly string[]; finished?: readonly string[] } | { stage: "done"; read?: true };

const check = (value: unknown): GuideStage | null => {
  if (typeof value !== "object" || value === null) return null;
  const { stage, at, seen, intro, finished, read: readToEnd } = value as { stage?: unknown; at?: unknown; seen?: unknown; intro?: unknown; finished?: unknown; read?: unknown };
  const ids = (list: unknown) => Array.isArray(list) ? list.filter((id): id is string => typeof id === "string") : [];
  const read = ids(seen), done = ids(finished);
  const kept = done.length ? { finished: done } : {};
  if (stage === "started" && typeof at === "number") return { stage, at, seen: read, ...intro === true ? { intro } : {}, ...kept };
  if (stage === "turn") return { stage, seen: read, ...kept };
  return stage === "done" ? { stage, ...readToEnd === true ? { read: readToEnd } : {} } : null;
};
/** Each screen's guide's stage on this browser, kept apart: one goes on, or is over, whatever the other does. */
export const guideStages: Record<GuideScreen, DeviceValue<GuideStage | null>> = {
  computer: deviceValue<GuideStage | null>("alpacawork.guide", jsonCodec<GuideStage | null>(check), null),
  phone: deviceValue<GuideStage | null>("alpacawork.guide.phone", jsonCodec<GuideStage | null>(check), null),
};
/** Ends a screen's guide for good on this browser, closed by hand (read to its end, it is stored over as `read`: nextStage). */
export const closeGuide = (screen: GuideScreen) => { guideStages[screen].set({ stage: "done" }); };
/**
 * Settings' "Show again": the computer's guide starts over from its first step, whatever the work, with nothing it
 * keeps on this browser read (the steps put away); the detail closes, so that step is seen over the list, which stays
 * as it is.
 */
export const restartGuide = () => {
  guideStages.computer.set({ stage: "started", at: Date.now(), seen: [], intro: true });
  if (useViewStore.getState().reader.open) useViewStore.getState().closeReader();
};
/** A guide going on, or none (never started, or over): what decides whether anything else is read for it. */
export type GoingStage = Exclude<GuideStage, { stage: "done" }>;
export const going = (stage: GuideStage | null): GoingStage | null => stage && stage.stage !== "done" ? stage : null;
/**
 * A screen's guide moved on from `from` to `to`: stored only while `from` is still what is stored, so a stage decided
 * on what this tab saw never overwrites what another tab stored meanwhile (closed there, say).
 */
export function moveGuide(screen: GuideScreen, from: GuideStage | null, to: GuideStage) {
  if (JSON.stringify(guideStages[screen].get()) === JSON.stringify(from)) guideStages[screen].set(to);
}
/** A step of a screen's guide read and put away ("Got it"): the guide goes on to the next one that holds. */
export const putAway = (screen: GuideScreen, id: string) => {
  const stage = guideStages[screen].get();
  if (stage && stage.stage !== "done" && !stage.seen.includes(id)) guideStages[screen].set({ ...stage, seen: [...stage.seen, id] });
};
