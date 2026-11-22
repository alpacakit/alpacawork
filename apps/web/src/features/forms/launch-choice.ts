import { useEffect } from "react";
import { create } from "zustand";
import { launchMemoryRequestSchema, launchMemoryResponseSchema, type LaunchMemoryChange } from "@alpacawork/contract/agent-selection";
import type { Selection } from "@alpacawork/contract/agent-settings";
import { useFrameSelector } from "@/data/workspace-store";
import { workspaceWriteBasis } from "@/data/connection";
import { api } from "@/data/resources";
import { notify } from "@/lib/notify";
import { isAgentView } from "@/lib/agent-view";
import type { WorkspaceInfo } from "@/data/types";
import { agentOffers, type AgentOffer } from "./agent-offers";
import { coordinatorStart, launchSelection, selectionReady, type SelectionBasis } from "./launch-selection";

type Profile = WorkspaceInfo["profiles"][number];
type Values = Record<string, string | null>;
const NO_PROFILES: Profile[] = [];
const NO_MEMORY: WorkspaceInfo["launchMemory"] = { agent: null, values: {} };

/**
 * Saves a change to the person's launch memory on the server; the index brings it back to every screen. It is where the
 * next new conversation starts, not this send: the input says a failure and does not wait for it (setup does).
 */
export async function saveLaunchMemory(change: LaunchMemoryChange) {
  // A `?agent=1` page is an agent checking the screen, not the person: its picks leave the person's memory alone.
  if (isAgentView()) return;
  await api.request("launch-memory", launchMemoryResponseSchema, undefined, launchMemoryRequestSchema.parse({ change }),
    crypto.randomUUID(), workspaceWriteBasis());
}
const sayUnsaved = (error: unknown) => notify.failure(error, { about: "launch-memory" });

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
 * What every prompt input sends with (the agent picker in its send row). A new launch starts from the person's last
 * choices, kept on the server for every device (coordinatorStart fills what was never chosen, or is no longer offered).
 * An input that goes on in a conversation starts from that conversation's previous values and sends only what the
 * person changes here, so a choice made elsewhere never overrides the conversation.
 */
export function useLaunchChoice(conversation?: ConversationLaunch) {
  const offers = agentOffers(useFrameSelector(data => data?.info.profiles) ?? NO_PROFILES);
  const stored = useFrameSelector(data => data?.info.launchMemory) ?? NO_MEMORY;
  const own = useConversationChanges(state => state.conversation === (conversation?.id ?? null) ? state : null);
  const find = (key: string | null | undefined) => key ? offers.find(item => item.key === key) : undefined;
  // The agent this send goes to: the person's pick here, else the conversation's. One the settings no longer enable is
  // never replaced by another: it stays, unavailable, until the person picks again. Only the remembered hint falls back.
  const current = own?.agent ?? conversation?.agent ?? null;
  const offer = current ? find(current) : find(stored.agent) ?? offers[0];
  const gone = current && !offer ? current : null;
  const profile = offer?.key ?? gone ?? "";
  const basis = selectionBasis(profile, conversation, offer ? coordinatorStart(offer.offer, stored.values[profile]) : {});
  // What the person changed here is theirs: checked as chosen, never quietly replaced. Going on in a conversation, it
  // stays for the conversation; for a new launch, only until the memory holds it (below).
  const changes = own?.agent === profile ? own.changes : {};
  const view = offer ? launchSelection(offer.offer, basis, changes) : { choices: [], shown: {}, send: {}, problems: [] };
  // A new conversation starts from the shared memory and the offered values: a change here the memory now holds is let
  // go, so a later choice on another device, or a config that drops the value, is what it follows. A conversation
  // already under way keeps its own picks (another agent picked for it among them).
  const newLaunch = !conversation?.agent;
  useEffect(() => {
    if (!newLaunch || !own?.agent) return;
    const kept = stored.values[own.agent] ?? {};
    const open = Object.fromEntries(Object.entries(own.changes).filter(([key, value]) => !(Object.hasOwn(kept, key) && kept[key] === value)));
    const agentHeld = stored.agent === own.agent, rest = Object.keys(open).length;
    if (agentHeld && !rest) useConversationChanges.setState({ conversation: own.conversation, agent: null, changes: {} });
    else if (rest < Object.keys(own.changes).length) useConversationChanges.setState({ ...own, changes: open });
  }, [newLaunch, own, stored]);
  const change = (target: AgentOffer, update: Values) => {
    const key = conversation?.id ?? null, before = changesFor(key);
    // An unsettled change stays until it is chosen again (launchSelection says it), even when another row changes.
    useConversationChanges.setState({ conversation: key, agent: target.key,
      changes: { ...(before.agent === target.key ? before.changes : {}), ...update } });
    // The server keeps the last choice for the next new launch, on every device: only the rows chosen now, laid over
    // what it keeps, so a choice made on another device for another row stays.
    saveLaunchMemory({ kind: "choose", agent: target.key, values: update }).catch(sayUnsaved);
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
 * The agent chosen in setup (the first enabled one in config order) is where a new launch starts: the remembered
 * agent is let go, and the values kept for each agent stay.
 */
export async function forgetLaunchAgent() {
  useConversationChanges.setState({ conversation: null, agent: null, changes: {} });
  await saveLaunchMemory({ kind: "forget-agent" });
}
