import { automationIdSchema } from "@alpacawork/contract/automation";

/**
 * Where the automations face stands, as the URL says it (`face=automations`): the table of every automation, or the
 * runs of all of them (`automations=runs`). One automation is not a place of the face: it opens in the reader's window
 * over whatever face is shown (`OpenAutomation`), as a task does.
 */
export type AutomationsPane = "list" | "runs";
export type AutomationsPlace = { tab: AutomationsPane };

export const automationsHome: AutomationsPlace = { tab: "list" };

type Values = { get: (key: string) => string | null };
/** The automations face the URL names, or null on another face. */
export function readAutomations(url: Values): AutomationsPlace | null {
  if (url.get("face") !== "automations") return null;
  return { tab: url.get("automations") === "runs" ? "runs" : "list" };
}

export const AUTOMATIONS_KEYS = ["face", "automations"] as const;
/** The URL's values for a place, in one order. */
export function automationsValues(place: AutomationsPlace | null): [typeof AUTOMATIONS_KEYS[number], string][] {
  if (!place) return [];
  return place.tab === "runs" ? [["face", "automations"], ["automations", "runs"]] : [["face", "automations"]];
}

/** Going from the table to the runs (or back) is a step of its own, as coming to the face or leaving it is. */
export function automationsMoved(before: AutomationsPlace | null, after: AutomationsPlace | null): boolean {
  if (!before || !after) return before !== after;
  return before.tab !== after.tab;
}

/** What of the automation open is shown: what it does (`about`), its runs (`log`), its files (`code`). */
export type AutomationPane = "about" | "log" | "code";
/** The automation open in the reader's window (`automation=A12`, its pane as `automationTab`), on any face. */
export type OpenAutomation = { id: string; pane: AutomationPane };

export const OPEN_AUTOMATION_KEYS = ["automation", "automationTab"] as const;
/** The automation the URL opens, or null. */
export function readOpenAutomation(url: Values): OpenAutomation | null {
  const id = url.get("automation");
  if (id === null || !automationIdSchema.safeParse(id).success) return null;
  const tab = url.get("automationTab");
  return { id, pane: tab === "log" || tab === "code" ? tab : "about" };
}
export function openAutomationValues(open: OpenAutomation | null): [typeof OPEN_AUTOMATION_KEYS[number], string][] {
  if (!open) return [];
  return open.pane === "about" ? [["automation", open.id]] : [["automation", open.id], ["automationTab", open.pane]];
}
