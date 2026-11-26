/**
 * Where one offered skill stands on this PC, for its row in Settings. A skill that comes with alpacawork has no version
 * of its own (an update of alpacawork replaces it): it is installed or not. One fetched from GitHub is versioned by
 * the day its folder there last changed: the day recorded when it was installed, and the latest read from GitHub.
 * It is behind when the latest is later, or when the day it was installed from is not known; the latest not read
 * leaves an installed one as installed, never behind.
 */
export type SkillVersionState =
  | { kind: "absent" }
  | { kind: "installed" }
  | { kind: "current" }
  | { kind: "behind" };

export function skillVersionState(input: { bundled: boolean; installed: boolean; installedAt: string | null; latestAt: string | null }): SkillVersionState {
  if (!input.installed) return { kind: "absent" };
  if (input.bundled || input.latestAt === null) return { kind: "installed" };
  if (input.installedAt === null) return { kind: "behind" };
  return Date.parse(input.latestAt) > Date.parse(input.installedAt) ? { kind: "behind" } : { kind: "current" };
}
