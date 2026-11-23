import { expect, test } from "vitest";
import { serverDraftActions, type ServerDraftActions, type ServerDraftState } from "../src/features/panels/server-draft-actions";

/** Unchanged, writable, nothing out: each row says only what differs. */
const settled: ServerDraftState = { dirty: false, writable: true, saving: false, unconfirmed: false, otherWrite: false, awaited: false };
const none: ServerDraftActions = { edit: false, discard: false, save: false, reread: false };

// The settings' rule from when the draft had one place, with its additions for two: the limits hold with the AI fields,
// nothing saves or reads again while an answer is awaited, and a save that is out keeps its draft from being discarded.
const table: [string, Partial<ServerDraftState>, Partial<ServerDraftActions>][] = [
  ["unchanged", {}, { edit: true, reread: true }],
  ["unsaved changes", { dirty: true }, { edit: true, discard: true, save: true, reread: true }],
  ["save out", { dirty: true, saving: true, awaited: true }, {}],
  ["save being checked", { dirty: true, awaited: true }, { edit: true, discard: true }],
  ["reading again", { dirty: true, awaited: true }, { edit: true, discard: true }],
  ["save not confirmed", { dirty: true, unconfirmed: true }, { discard: true, reread: true }],
  ["another write on it out", { dirty: true, otherWrite: true }, { discard: true, reread: true }],
  ["cannot write, unchanged", { writable: false }, { reread: true }],
  ["cannot write, unsaved changes", { dirty: true, writable: false }, { discard: true, reread: true }],
];

for (const [name, state, allowed] of table) test(`draft controls: ${name}`, () => {
  expect(serverDraftActions({ ...settled, ...state })).toEqual({ ...none, ...allowed });
});
