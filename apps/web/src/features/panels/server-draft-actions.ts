/** What the settings dialog's config.yaml draft is doing, as its two places (the AI tab, General's Advanced options) read it. */
export type ServerDraftState = {
  /** The draft differs from what was last read or saved. */
  dirty: boolean;
  /** This screen may write: not offline, not read-only. */
  writable: boolean;
  /** A save is out: sent and not answered yet. */
  saving: boolean;
  /** A save's answer was lost. */
  unconfirmed: boolean;
  /** Another write on the same subject is out. */
  otherWrite: boolean;
  /** An answer is awaited from either place: a save (being checked or out), or a read of the latest or its retry. */
  awaited: boolean;
};

/**
 * What can be typed or pressed, the same in both places: the fields (the AI tab's and the limits alike), discard, save,
 * and the ways to read again ("Read the latest" and a failed read's "Retry"; where they are shown is the settings' own).
 */
export type ServerDraftActions = { edit: boolean; discard: boolean; save: boolean; reread: boolean };

/**
 * The settings' rule from when the draft had one place, with what its two places add: the limits hold still when the AI
 * fields do; while an answer is awaited from either place, neither saves or reads again; and while a save is out, its
 * draft is not discarded (a draft emptied meanwhile would miss the save's new hash, and the next save would be refused).
 */
export function serverDraftActions(state: ServerDraftState): ServerDraftActions {
  const held = !state.writable || state.saving || state.unconfirmed || state.otherWrite;
  return {
    edit: !held,
    discard: state.dirty && !state.saving,
    save: state.dirty && !held && !state.awaited,
    reread: !state.awaited,
  };
}
