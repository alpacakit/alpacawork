import { type DraftEntry, useDraftStore } from "../src/features/forms/draft-store";

/** Put a draft in the same in-memory store as a mounted composer. */
export function seedDraft(key: string, entry: Omit<DraftEntry, "status">): void {
  const entries = { ...useDraftStore.getState().entries, [key]: { ...entry, status: "editing" as const } };
  useDraftStore.setState({ entries });
}
