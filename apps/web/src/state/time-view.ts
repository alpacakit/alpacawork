import { create } from "zustand";
import { navigate } from "@/lib/history";
import { readSetting, writeSetting } from "./screen-settings";

/**
 * Whether a narrow list draws its time strips, its zoom, and the event picked in them.
 * Shared URL and device settings are read and written by screen-settings.ts.
 */
/**
 * The time axis is a strip the reader scrolls sideways, so the only thing kept here is its
 * zoom: how much time one screen-width of it shows (`viewMs`; null = 24 hours), or all of time (whatever zoom
 * has all of the strip in sight, at every width and every now). Where it is scrolled to is the scroller's own state.
 */
type TimeViewState = {
  strips: boolean;
  viewMs: number | "all" | null;
  setViewMs: (viewMs: number | "all" | null) => void;
  picked: { taskId: string; key: string } | null;
  hovered: { taskId: string; key: string } | null;
  setStrips: (strips: boolean) => void;
  pick: (taskId: string, key: string | null) => void;
  hover: (taskId: string, key: string | null) => void;
};

const zoomOf = (value: string) => value === "all" ? "all" : Number(value) || null;

export const useTimeView = create<TimeViewState>((set) => ({
  strips: readSetting("strip") === "on",
  picked: null,
  hovered: null,
  viewMs: zoomOf(readSetting("zoom")),
  // A setting is in the URL too: written in turn with every other change of it (lib/history.ts).
  setViewMs: (viewMs) => navigate(() => { writeSetting("zoom", viewMs === null ? null : viewMs === "all" ? viewMs : String(Math.round(viewMs))); set({ viewMs }); }),
  setStrips: (strips) => navigate(() => { writeSetting("strip", strips ? "on" : "off"); set({ strips }); }),
  pick: (taskId, key) => set({ picked: key ? { taskId, key } : null }),
  hover: (taskId, key) => set({ hovered: key ? { taskId, key } : null }),
}));

export function applyTimeViewUrl(url = new URL(location.href)) {
  useTimeView.setState({ strips: readSetting("strip", url) === "on", viewMs: zoomOf(readSetting("zoom", url)) });
}
