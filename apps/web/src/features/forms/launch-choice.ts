import { create } from "zustand";
import type { Selection } from "@alpacawork/contract/agent-settings";
import { deviceValue, jsonCodec, useDeviceValue } from "@/lib/device-storage";
import { useFrameSelector } from "@/data/workspace-store";
import type { WorkspaceInfo } from "@/data/types";
import { agentOffers, type AgentOffer } from "./agent-offers";
import { launchSelection, selectionReady, type SelectionBasis } from "./launch-selection";

type Profile = WorkspaceInfo["profiles"][number];
type Values = Record<string, string | null>;
/** The agent kind last chosen on this device, and by kind the launch values last chosen for it (null: "none", a written -). */
type Stored = { agent: string | null; values: Record<string, Values> };
const NO_PROFILES: Profile[] = [];
const isValues = (value: unknown): value is Values => !!value && typeof value === "object" && !Array.isArray(value)
  && Object.values(value).every(each => each === null || typeof each === "string");
const storedChoice = deviceValue<Stored>("alpacawork.launchChoice", jsonCodec((value) => {
  const stored = value as Partial<Stored> | null;
  const values = stored?.values;
  return { agent: typeof stored?.agent === "string" ? stored.agent : null,
    values: values && typeof values === "object" && !Array.isArray(values)
      ? Object.fromEntries(Object.entries(values).filter(([, each]) => isValues(each))) : {} };
}), { agent: null, values: {} });
function remember(agent: string, values: Values) {
  storedChoice.set({ agent, values: { ...storedChoice.get().values, [agent]: values } });
}

/**
 * The person's own changes to the conversation shown, for this visit: the agent picked for it and the values changed.
 * Shared by every input of the conversation; another conversation starts with none.
 */
export const useConversationChanges = create<{ conversation: string | null; agent: string | null; changes: Values }>(() =>
  ({ conversation: null, agent: null, changes: {} }));
const changesFor = (conversation: string | null) => {
  const state = useConversationChanges.getState();
  return state.conversation === conversation ? state : { conversation, agent: null, changes: {} };
};

/** A conversation an input goes on with: its agent, and its previous launch values when the server says them. */
export type ConversationLaunch = { id: string; agent: string | null; previous: Selection | null };

/** The basis a send to `agent` starts from: the conversation's previous values when it goes on in it, else a new launch. */
export function selectionBasis(agent: string, conversation: ConversationLaunch | undefined, hints: Values | undefined): SelectionBasis {
  return conversation && conversation.agent === agent
    ? { kind: "continue", previous: conversation.previous ?? {} }
    : { kind: "new", hints: hints ?? {} };
}

/**
 * What every prompt input sends with (the agent picker in its send row). A new launch starts from this device's last
 * choices, kept on this device. An input that goes on in a conversation starts from that conversation's previous
 * values and sends only what the person changes here, so a choice made elsewhere never overrides the conversation.
 */
export function useLaunchChoice(conversation?: ConversationLaunch) {
  const offers = agentOffers(useFrameSelector(data => data?.info.profiles) ?? NO_PROFILES);
  const stored = useDeviceValue(storedChoice);
  const own = useConversationChanges(state => state.conversation === (conversation?.id ?? null) ? state : null);
  const find = (key: string | null | undefined) => key ? offers.find(item => item.key === key) : undefined;
  // The agent this send goes to: the person's pick here, else the conversation's. One the settings no longer enable is
  // never replaced by another: it stays, unavailable, until the person picks again. Only this device's hint falls back.
  const current = own?.agent ?? conversation?.agent ?? null;
  const offer = current ? find(current) : find(stored.agent) ?? offers[0];
  const gone = current && !offer ? current : null;
  const profile = offer?.key ?? gone ?? "";
  const basis = selectionBasis(profile, conversation, stored.values[profile]);
  // What the person changed here is theirs, new launch or not: checked as chosen, never quietly replaced. The device's
  // choices are only where a new launch starts (shared with other tabs), and fall back when the config outgrew them.
  const changes = own?.agent === profile ? own.changes : {};
  const view = offer ? launchSelection(offer.offer, basis, changes) : { choices: [], shown: {}, send: {}, problems: [] };
  const change = (target: AgentOffer, update: Values) => {
    const key = conversation?.id ?? null, before = changesFor(key);
    useConversationChanges.setState({ conversation: key, agent: target.key,
      // An unsettled change stays until it is chosen again (launchSelection says it), even when another row changes.
      changes: { ...(before.agent === target.key ? before.changes : {}), ...update } });
    // The device keeps the last choice for the next new launch.
    remember(target.key, launchSelection(target.offer, { kind: "new", hints: storedChoice.get().values[target.key] ?? {} }, update).send);
  };
  return { profiles: offers, profile, choices: view.choices, selected: view.shown, problems: view.problems,
    /** The agent this send went to, which the settings no longer enable: the person picks another. */
    gone, ready: !gone && selectionReady(view),
    /** What the send carries: null is "none" (a written -). */
    send: view.send,
    /** Changes some values; a value the change leaves inactive (the effort of a model without one) is not sent. */
    setSelected: (update: Values) => { if (offer) change(offer, update); },
    chooseProfile: (key: string, overrides: Values = {}) => { const target = find(key); if (target) change(target, overrides); } };
}
export type LaunchChoice = ReturnType<typeof useLaunchChoice>;

/** The launch picker's menu on this screen (the coordinator's input), opened by a new admission that cannot go yet. */
export const useLaunchPicker = create<{ open: boolean }>(() => ({ open: false }));
/**
 * The one check every new admission meets before it fixes a request ID and its selection (selectionReady): not ready,
 * the picker opens instead. A request already fixed and sent again keeps its own values and does not come here.
 */
export function admitLaunch(choice: Pick<LaunchChoice, "ready"> | null): boolean {
  if (!choice || choice.ready) return true;
  useLaunchPicker.setState({ open: true });
  return false;
}

/**
 * The agent chosen in setup (the first enabled one in config order) is where a new launch starts: this
 * device's remembered agent is let go, and the values kept for each agent stay.
 */
export function forgetLaunchAgent() {
  storedChoice.set({ ...storedChoice.get(), agent: null });
  useConversationChanges.setState({ conversation: null, agent: null, changes: {} });
}
