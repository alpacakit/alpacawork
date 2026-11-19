import { create } from "zustand";
import type { ReaderCard } from "@/features/reader/next-question";

/** The settings dialog's tabs; Host status can be opened from its banner and its push, Projects from the archive notices. */
export type SettingsTab = "personal" | "server" | "apps" | "host" | "projects";

/**
 * The one thing open at a time: a modal dialog (settings,
 * diagnostics, the close confirmation of a run) or an input drawn in
 * the reader. Retained input data lives in draft-store, independently of this display state.
 */
export type OpenDialog =
  /** `request` counts openings, so asking for a tab while the dialog is open moves it there without remounting it. */
  | { kind: "settings"; tab?: SettingsTab; focusNotifications?: boolean; request?: number }
  | { kind: "diagnostics" }
  /**
   * A project's settings: Create project (`project` left out), or one project's (`null`: every project is shown, and
   * the dialog asks which).
   */
  | { kind: "project"; project?: string | null }
  | ({ kind: "run" } & RunFormTarget)
  | OpenInput;

/**
 * An input that is not a modal: the state popover, a section inside the reader, for the task the reader shows. It is
 * still "the one open input": opening another closes it, as with dialogs.
 */
export type InputForm = "report" | "responsible" | "move";
export type OpenInput = { kind: "input"; form: InputForm; taskId: string;
  /** The state form's: the reader's card it was opened on (none where the reader did not show its task). */
  answerCard?: ReaderCard | null };

/** The confirmation for closing a run review. */
export type RunFormTarget = { runId: string };

type DialogState = {
  dialog: OpenDialog | null;
  /**
   * The dialogs behind the open one, the nearest last: a dialog opened from another one (a project's settings from
   * Settings' Projects) keeps that one behind it, as it showed then (its tab). Back (`back`) brings the nearest one back;
   * closing (×, Esc, a click outside, a phone's Back) closes them all, and an input opened closes them too.
   */
  behind: OpenDialog[];
  /** The tab the settings were last on; the gear opens there. */
  settingsTab: SettingsTab;
  rememberSettingsTab: (tab: SettingsTab) => void;
  openRun: (target: RunFormTarget) => void;
  open: (kind: "settings" | "diagnostics", options?: { tab?: SettingsTab; focusNotifications?: boolean }) => void;
  /** Create project with no `project`; a project's settings with its ID, or `null` to choose it there. */
  openProject: (project?: string | null) => void;
  openInput: (input: Omit<OpenInput, "kind">) => void;
  /** Back to the nearest dialog behind the open one; with none behind, closes it. */
  back: () => void;
  close: () => void;
};

/**
 * What opening `next` keeps behind it: the open dialog joins those behind it when it is another dialog; one of the same
 * kind (Settings asked for a tab, another project's settings) only takes its place.
 */
const behindOf = (state: Pick<DialogState, "dialog" | "behind">, next: OpenDialog): OpenDialog[] => {
  const open = state.dialog;
  if (!open || open.kind === "input") return [];
  return open.kind === next.kind ? state.behind : [...state.behind, open];
};
const show = (state: Pick<DialogState, "dialog" | "behind">, next: OpenDialog) => ({ dialog: next, behind: behindOf(state, next) });

export const useDialogStore = create<DialogState>((set) => ({
  dialog: null,
  behind: [],
  settingsTab: "personal",
  // The open Settings' record names the tab it shows, so kept behind another dialog it comes back there.
  rememberSettingsTab: (tab) => set((state) => ({ settingsTab: tab,
    ...state.dialog?.kind === "settings" && state.dialog.tab !== tab ? { dialog: { ...state.dialog, tab } } : {} })),
  openRun: (target) => set((state) => show(state, { kind: "run", ...target })),
  open: (kind, options) => set((state) => show(state, kind === 'settings'
    ? { kind, ...options, tab: options?.tab ?? state.settingsTab, request: (state.dialog?.kind === 'settings' ? state.dialog.request ?? 0 : 0) + 1 }
    : { kind })),
  openProject: (project) => set((state) => show(state, project === undefined ? { kind: "project" } : { kind: "project", project })),
  openInput: (input) => set({ dialog: { kind: "input", ...input }, behind: [] }),
  back: () => set((state) => ({ dialog: state.behind.at(-1) ?? null, behind: state.behind.slice(0, -1) })),
  close: () => set({ dialog: null, behind: [] }),
}));

/**
 * Opens the settings: at `tab`, or left out, at the tab they were last on.
 */
export const openSettings = (tab?: SettingsTab) => useDialogStore.getState().open("settings", tab ? { tab } : undefined);

/** The open dialog's Back: back to the dialog it was opened from, or none when nothing is behind it. */
export const useDialogBack = (): (() => void) | undefined => {
  const behind = useDialogStore((state) => state.behind.length > 0);
  const back = useDialogStore((state) => state.back);
  return behind ? back : undefined;
};
