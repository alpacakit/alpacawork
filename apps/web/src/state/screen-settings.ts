import { deviceValue } from "@/lib/device-storage";
import { navigate, replaceStep } from "@/lib/history";

/** One vocabulary for shareable URL state and settings kept on this device. */
/** On a narrow screen the time strips are under the rows only when asked for (Time); a wide one always has them. */
const STRIP_OPTIONS = ["off", "on"] as const;
/** Docked reader geometry: used both when saving a drag and when fitting the current viewport.
 * A smaller screen only fits the view; it does not overwrite the saved preference.
 */
export const READER_MIN_WIDTH = 420;
/** The reader starts beside the list only when the narrowest reader leaves 480px. */
const MIN_WORKSPACE_WIDTH = 480;
export const MIN_DOCK_VIEWPORT_WIDTH = READER_MIN_WIDTH + MIN_WORKSPACE_WIDTH;
const MIN_VISIBLE_LIST_WIDTH = 144;
/** The docked window's margin from the screen's edges (styles.css, Head line: `--spacing-window`), read where it is drawn. */
export const windowMargin = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--spacing-window"));
/** Keep one tenth of a wide screen visible; a small desktop still needs a usable list edge. */
export const maxDockedReaderWidth = (viewport: number) =>
  Math.max(READER_MIN_WIDTH, Math.round(viewport - windowMargin() - Math.max(viewport * 0.1, MIN_VISIBLE_LIST_WIDTH)));
/** The widest the docked reader goes while a diff or a file stands beside it: what leaves that place `least` (Workbench). */
export const readerWidthBeside = (viewport: number, least: number) => Math.max(READER_MIN_WIDTH, viewport - 3 * windowMargin() - least);
export function fitReaderWidth(width: number | null, viewport: number): number {
  return Math.max(READER_MIN_WIDTH, Math.min(width ?? Math.min(viewport * 0.38, 720), maxDockedReaderWidth(viewport)));
}
/** The list's title column where the list is narrow (TimeTree), kept as it is however wide the reader grows. */
export const TITLE_COLUMN_TIGHT = 330;
/**
 * The list's title column for a list `sheet` wide: tight under 900px; past it a third of the list, so a title of
 * everyday length is read whole, never under 360px and never over 480px, where the time would lose its room to a title.
 */
export const titleColumnWidth = (sheet: number) =>
  sheet < 900 ? TITLE_COLUMN_TIGHT : Math.min(480, Math.max(360, Math.round(sheet * 0.34)));
/** The least of the time strip the list keeps beside its titles: now, the reports expected after it and a little before. */
const LEAST_STRIP_WIDTH = 200;
/** The list's insets around them: 24px at its left, 36px between it and the reader (Workbench). */
const LEAST_LIST_WIDTH = 24 + TITLE_COLUMN_TIGHT + LEAST_STRIP_WIDTH + 36;
/**
 * The list gives the reader its width until it is down to its titles and the least strip; a wider reader overlaps
 * it. On a screen too narrow for that, the reader still has what the docking boundary leaves it beside the list.
 */
export const readerListReservation = (width: number, viewport: number) =>
  Math.min(width, Math.max(MIN_WORKSPACE_WIDTH, viewport - LEAST_LIST_WIDTH));
/**
 * Until the reader is half the screen, the list's time strip is squeezed into what is left of it. What the list gives
 * past that hides the strip's oldest part instead: the strip keeps the scale it had there, so now and the reports
 * expected after it stay in sight.
 */
export const stripHidden = (width: number, viewport: number) =>
  readerListReservation(width, viewport) - Math.min(width, Math.max(MIN_WORKSPACE_WIDTH, viewport * 0.5));
/** Crossing the docked limit with the handle uses the same full-width state as the header button. */
export function draggedReaderWidth(clientX: number, viewport: number): number | "full" {
  const requested = Math.round(viewport - windowMargin() - clientX);
  return requested > maxDockedReaderWidth(viewport) ? "full" : fitReaderWidth(requested, viewport);
}

/** While the reader's edge is held (dragged), the list keeps the layout it had; it is laid out again once let go. */
const heldListeners = new Set<() => void>();
let edgeHeld = false;
export const readerEdgeHeld = {
  get: () => edgeHeld,
  set: (held: boolean) => { if (held === edgeHeld) return; edgeHeld = held; for (const notify of heldListeners) notify(); },
  subscribe: (notify: () => void) => { heldListeners.add(notify); return () => { heldListeners.delete(notify); }; },
};
let letGo = 0;
/**
 * The person changing the reader's width by its edge: held while the hand holds it (or for one change by the keys).
 * Let go, it stays held until the frame that lays out the last width has been drawn, so what stands beside the reader
 * (the coordinator) still reads that width as the person's.
 */
export function holdReaderEdge(held: boolean) {
  cancelAnimationFrame(letGo);
  if (held) { readerEdgeHeld.set(true); return; }
  letGo = requestAnimationFrame(() => { letGo = requestAnimationFrame(() => readerEdgeHeld.set(false)); });
}

const SCREEN_KEYS = {
  strip: { storage: true, default: "off", valid: (v: string) => STRIP_OPTIONS.some((each) => each === v) },
  width: { storage: false },
  zoom: { storage: true, default: "", valid: (v: string) => v === "all" || /^\d+$/.test(v) && Number.isSafeInteger(Number(v)) && Number(v) >= 60_000 },
  project: { storage: false }, task: { storage: false }, tab: { storage: false }, path: { storage: false },
  q: { storage: false }, set: { storage: false }, event: { storage: false }, image: { storage: false },
  view: { storage: false },
  theme: { storage: false }, settings: { storage: false },
  // The analysis face and what is open on it (features/analysis/place.ts).
  face: { storage: false }, look: { storage: false }, span: { storage: false }, list: { storage: false },
  measure: { storage: false }, group: { storage: false }, member: { storage: false }, bin: { storage: false }, unit: { storage: false },
  model: { storage: false }, effort: { storage: false },
  card: { storage: false },
} as const;
type ScreenKey = keyof typeof SCREEN_KEYS;
type SettingKey = { [K in ScreenKey]: typeof SCREEN_KEYS[K] extends { storage: true } ? K : never }[ScreenKey];

const setting = (key: SettingKey) => {
  const rule = SCREEN_KEYS[key];
  return deviceValue(`alpacawork.screen.${key}`, { read: (raw) => rule.valid(raw) ? raw : null, write: String }, rule.default as string);
};
export const screenSettings = { strip: setting("strip"), zoom: setting("zoom") };

/** Last requested partial width in px. URL mode and viewport constraints never write this preference. */
export const readerWidth = deviceValue<number | null>("alpacawork.screen.width", {
  read: (raw) => /^\d+$/.test(raw) && Number.isSafeInteger(Number(raw)) && Number(raw) >= READER_MIN_WIDTH ? Number(raw) : null,
  write: String,
}, null);

export const urlValue = (key: ScreenKey, url = new URL(location.href)) => url.searchParams.get(key);
export function setUrlValue(key: ScreenKey, value: string | null, url = new URL(location.href)): URL {
  if (value === null || value === "") url.searchParams.delete(key); else url.searchParams.set(key, value);
  return url;
}
/** Every task a URL names: the reader's and the list's starting point. */
export const addressesIn = (url: URL) => [urlValue("project", url), urlValue("task", url)].filter((address): address is string => !!address);
/** Links to a screen use the same key vocabulary without copying the current visit. */
export function screenLink(values: Partial<Record<ScreenKey, string>>): string {
  const url = new URL("/", location.href);
  for (const key of Object.keys(values) as ScreenKey[]) setUrlValue(key, values[key] ?? null, url);
  return `${url.pathname}${url.search}`;
}

/** Writes one value over the current step, in turn with every other change of the URL (lib/history.ts). */
export function writeUrlValue(key: ScreenKey, value: string | null) {
  navigate(() => replaceStep(history.state, setUrlValue(key, value)));
}

export function readSetting<K extends SettingKey>(key: K, url = new URL(location.href)): string {
  const rule = SCREEN_KEYS[key];
  const fromUrl = urlValue(key, url);
  const candidate = fromUrl !== null ? fromUrl : screenSettings[key].get();
  const value = candidate !== null && rule.valid(candidate) ? candidate : rule.default;
  return value;
}
export function writeSetting(key: SettingKey, value: string | null) {
  const rule = SCREEN_KEYS[key];
  const valid = value !== null && rule.valid(value) ? value : null;
  if (valid === null) screenSettings[key].remove(); else screenSettings[key].set(valid);
  writeUrlValue(key, valid);
}
