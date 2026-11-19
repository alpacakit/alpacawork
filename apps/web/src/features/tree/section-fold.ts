import { HOME_SECTIONS, type HomeSection } from "@alpacawork/contract";
import { deviceValue, jsonCodec } from "@/lib/device-storage";

/**
 * How each home section starts on a device where the reader has not opened or closed it yet. `rows`: how many rows an
 * open section shows before "N more".
 */
export const SECTION_START: Readonly<Record<HomeSection, { open: boolean; rows?: number }>> = {
  doing: { open: true, rows: 4 }, error: { open: true }, review: { open: true, rows: 10 },
  awaited: { open: false }, todo: { open: true }, held: { open: false }, done: { open: false },
};

/** Only the sections the reader set otherwise than they start; the rest follow SECTION_START. */
export type SectionsOpen = Partial<Record<HomeSection, boolean>>;
export const sectionsOpen = deviceValue<SectionsOpen>("alpacawork.homeSections", jsonCodec((value) => {
  if (typeof value !== "object" || value === null) return null;
  const kept: SectionsOpen = {};
  for (const section of HOME_SECTIONS) {
    const open = (value as Record<string, unknown>)[section];
    if (typeof open === "boolean") kept[section] = open;
  }
  return kept;
}), {});

/** What the reader sees of one section. `opened`: opened for this visit only, for the task open in the detail. */
export type FoldState = { stored: SectionsOpen; opened: ReadonlySet<HomeSection>; more: ReadonlySet<HomeSection> };

export const isOpen = (section: HomeSection, { stored, opened }: Pick<FoldState, "stored" | "opened">) =>
  opened.has(section) || (stored[section] ?? SECTION_START[section].open);

/**
 * `shown`: how many of its `length` rows are drawn. `hidden`: rows behind "N more" (0 while they are all shown); null when
 * there is no such button, as on a closed section or one within its first rows.
 */
export function sectionFold(section: HomeSection, length: number, state: FoldState): { open: boolean; shown: number; hidden: number | null } {
  const open = isOpen(section, state);
  if (!open) return { open, shown: 0, hidden: null };
  const first = SECTION_START[section].rows;
  if (first === undefined || length <= first) return { open, shown: length, hidden: null };
  const shown = state.more.has(section) ? length : first;
  return { open, shown, hidden: length - shown };
}

/** The stored choice after the reader sets `section` to `open`; a choice equal to how it starts is not kept. */
export function storedWith(stored: SectionsOpen, section: HomeSection, open: boolean): SectionsOpen {
  const next = { ...stored };
  if (open === SECTION_START[section].open) delete next[section]; else next[section] = open;
  return next;
}
