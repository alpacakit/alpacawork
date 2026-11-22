import { create } from "zustand";
import { applyLaunchMemory, launchMemoryRequestSchema, launchMemoryResponseSchema, type LaunchMemory, type LaunchMemoryChange } from "@alpacawork/contract/agent-selection";
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
 * Saves a change to the person's launch memory on the server; the index brings it back to every screen. False when
 * nothing is sent: a `?agent=1` page is an agent checking the screen, not the person, and leaves the memory alone.
 */
async function saveLaunchMemory(change: LaunchMemoryChange): Promise<boolean> {
  if (isAgentView()) return false;
  await api.request("launch-memory", launchMemoryResponseSchema, undefined, launchMemoryRequestSchema.parse({ change }),
    crypto.randomUUID(), workspaceWriteBasis());
  return true;
}
/**
 * The changes on their way to the server, laid over the shared memory until each one's answer is back. Answered,
 * saved or refused, a change goes: then the index's memory is what this screen shows, as it is on every other screen.
 * A change that was never sent (`?agent=1`) stays for this page.
 */
export const usePendingMemory = create<{ changes: { id: string; change: LaunchMemoryChange }[] }>(() => ({ changes: [] }));
function rememberLaunch(change: LaunchMemoryChange): Promise<void> {
  const id = crypto.randomUUID();
  usePendingMemory.setState(state => ({ changes: [...state.changes, { id, change }] }));
  const settle = () => usePendingMemory.setState(state => ({ changes: state.changes.filter(each => each.id !== id) }));
  return saveLaunchMemory(change).then(sent => { if (sent) settle(); }, error => { settle(); throw error; });
}
const sayUnsaved = (error: unknown) => notify.failure(error, { about: "launch-memory" });

/**
 * The person's own changes to a conversation going on, for this visit: the agent picked for it and the values changed.
 * Shared by every input of the conversation; another conversation starts with none. A new launch has none: it reads
 * the memory.
 */
export const useConversationChanges = create<{ conversation: string | null; agent: string | null; changes: Values }>(() =>
  ({ conversation: null, agent: null, changes: {} }));
const changesFor = (conversation: string | null) => {
  const state = useConversationChanges.getState();
  return state.conversation === conversation ? state : { conversation, agent: null, changes: {} };
};

/** A conversation an input goes on with: its agent, and its previous launch values when the server says them. */
export type ConversationLaunch = { id: string; agent: string | null; previous: Selection | null };

/**
 * The basis a send to `agent` starts from: the conversation's previous values when it goes on in it with them, else a
 * new launch from the shared memory. A conversation with no previous values (one whose only launch never got going)
 * has none to go on from, so it starts as a new one does.
 */
export function selectionBasis(agent: string, conversation: ConversationLaunch | undefined, hints: Values | undefined): SelectionBasis {
  return conversation?.previous && conversation.agent === agent
    ? { kind: "continue", previous: conversation.previous }
    : { kind: "new", hints: hints ?? {} };
}

/**
 * What every prompt input sends with (the agent picker in its send row). Going on in a conversation (one with previous
 * values), it starts from them and sends only what the person changes here, so a choice made elsewhere never overrides
 * the conversation. Any other send is a new launch: its agent and values come from the person's memory alone, kept on
 * the server for every device (with the changes still on their way), and coordinatorStart fills the rest.
 */
export function useLaunchChoice(conversation?: ConversationLaunch) {
  const offers = agentOffers(useFrameSelector(data => data?.info.profiles) ?? NO_PROFILES);
  const shared = useFrameSelector(data => data?.info.launchMemory) ?? NO_MEMORY;
  const pending = usePendingMemory(state => state.changes);
  const memory: LaunchMemory = pending.reduce((before, each) => applyLaunchMemory(before, each.change), shared);
  const goesOn = conversation?.previous ? conversation : undefined;
  const own = useConversationChanges(state => goesOn && state.conversation === goesOn.id ? state : null);
  const find = (key: string | null | undefined) => key ? offers.find(item => item.key === key) : undefined;
  // Going on, the agent is the person's pick here, else the conversation's. One the settings no longer enable is never
  // replaced by another: it stays, unavailable, until the person picks again. A new launch's agent is the memory's,
  // else the first enabled one.
  const current = goesOn ? own?.agent ?? goesOn.agent : null;
  const offer = current ? find(current) : find(memory.agent) ?? offers[0];
  const gone = current && !offer ? current : null;
  const profile = offer?.key ?? gone ?? "";
  const basis = selectionBasis(profile, goesOn, offer ? coordinatorStart(offer.offer, memory.values[profile]) : {});
  // What the person changed in the conversation is theirs: checked as chosen, never quietly replaced.
  const changes = own?.agent === profile ? own.changes : {};
  const view = offer ? launchSelection(offer.offer, basis, changes) : { choices: [], shown: {}, send: {}, problems: [] };
  const change = (target: AgentOffer, update: Values) => {
    if (goesOn) {
      const before = changesFor(goesOn.id);
      // An unsettled change stays until it is chosen again (launchSelection says it), even when another row changes.
      useConversationChanges.setState({ conversation: goesOn.id, agent: target.key,
        changes: { ...(before.agent === target.key ? before.changes : {}), ...update } });
    }
    // The server keeps the last choice for the next new launch, on every device: only the rows chosen now, laid over
    // what it keeps, so a choice made on another device for another row stays.
    rememberLaunch({ kind: "choose", agent: target.key, values: update }).catch(sayUnsaved);
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
  await rememberLaunch({ kind: "forget-agent" });
}
