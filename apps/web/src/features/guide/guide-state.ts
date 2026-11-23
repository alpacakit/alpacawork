import { deviceValue, jsonCodec } from "@/lib/device-storage";
import { useViewStore } from "@/state/view-store";

/**
 * How far this browser is through the getting-started guide: started (at the moment it began, so a request sent
 * afterwards is known as this guide's first one; `intro` while its first step is shown again whatever the work, until
 * another step holds), got as far as the person's turn (with the steps read and put away
 * since: `seen`), or over (finished or closed). `finished`: the Tasks the person pressed Done on since it began. Nothing stored is a browser that has never seen it.
 */
export type GuideStage = { stage: "started"; at: number; seen: readonly string[]; intro?: true; finished?: readonly string[] }
  | { stage: "turn"; seen: readonly string[]; finished?: readonly string[] } | { stage: "done" };

const check = (value: unknown): GuideStage | null => {
  if (typeof value !== "object" || value === null) return null;
  const { stage, at, seen, intro, finished } = value as { stage?: unknown; at?: unknown; seen?: unknown; intro?: unknown; finished?: unknown };
  const ids = (list: unknown) => Array.isArray(list) ? list.filter((id): id is string => typeof id === "string") : [];
  const read = ids(seen), done = ids(finished);
  const kept = done.length ? { finished: done } : {};
  if (stage === "started" && typeof at === "number") return { stage, at, seen: read, ...intro === true ? { intro } : {}, ...kept };
  if (stage === "turn") return { stage, seen: read, ...kept };
  return stage === "done" ? { stage } : null;
};
export const guideStage = deviceValue<GuideStage | null>("alpacawork.guide", jsonCodec<GuideStage | null>(check), null);
/** Ends the guide for good on this browser: closed by hand, or read to its end. */
export const closeGuide = () => { guideStage.set({ stage: "done" }); };
/**
 * Settings' "Show again": the guide starts over from its first step, whatever the work, with nothing it keeps on this
 * browser read (the steps put away); the detail closes, so that step is seen over the list, which stays as it is.
 */
export const restartGuide = () => {
  guideStage.set({ stage: "started", at: Date.now(), seen: [], intro: true });
  if (useViewStore.getState().reader.open) useViewStore.getState().closeReader();
};
/** A guide going on, or none (never started, or over): what decides whether anything else is read for it. */
export type GoingStage = Exclude<GuideStage, { stage: "done" }>;
export const going = (stage: GuideStage | null): GoingStage | null => stage && stage.stage !== "done" ? stage : null;
/**
 * The guide moved on from `from` to `to`: stored only while `from` is still what is stored, so a stage decided on what
 * this tab saw never overwrites what another tab stored meanwhile (closed there, say). Returns whether it was stored.
 */
export function moveGuide(from: GuideStage | null, to: GuideStage): boolean {
  if (JSON.stringify(guideStage.get()) !== JSON.stringify(from)) return false;
  guideStage.set(to);
  return true;
}
/** A step read and put away ("Got it"): the guide goes on to the next one that holds. */
export const putAway = (id: string) => {
  const stage = guideStage.get();
  if (stage && stage.stage !== "done" && !stage.seen.includes(id)) guideStage.set({ ...stage, seen: [...stage.seen, id] });
};
