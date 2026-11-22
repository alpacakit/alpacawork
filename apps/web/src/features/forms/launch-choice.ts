import { useEffect } from "react";
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
const NO_MEMORY: WorkspaceInfo["launchMemory"] = { agent: null, values: {}, version: 0 };

/**
 * Saves a change to the person's launch memory on the server: the answer is the record as saved. Null when nothing is
 * sent: a `?agent=1` page is an agent checking the screen, not the person, and leaves the memory alone.
 */
async function saveLaunchMemory(change: LaunchMemoryChange): Promise<LaunchMemory | null> {
  if (isAgentView()) return null;
  return (await api.request("launch-memory", launchMemoryResponseSchema, undefined, launchMemoryRequestSchema.parse({ change }),
    crypto.randomUUID(), workspaceWriteBasis())).memory;
}
/**
 * This screen's launch memory: `record`, the newest copy it has had from a save's answer (the index brings the rest;
 * of the two, the larger version is read), and `saving`, the changes in this screen's one line of saves, each shown
 * until its answer is back. Sends wait while it is not empty, so a send never goes with a value about to change.
 */
export const useLaunchRecord = create<{ record: LaunchMemory | null; saving: LaunchMemoryChange[] }>(() => ({ record: null, saving: [] }));
let line: Promise<unknown> = Promise.resolve();
const adopt = (memory: LaunchMemory) => useLaunchRecord.setState(state =>
  !state.record || memory.version > state.record.version ? { record: memory } : state);
/** Queues one save behind this screen's earlier ones, so the server takes them in the order they were made. */
function rememberLaunch(change: LaunchMemoryChange, shared: () => LaunchMemory): Promise<void> {
  useLaunchRecord.setState(state => ({ saving: [...state.saving, change] }));
  const done = line.then(async () => {
    try {
      const saved = await saveLaunchMemory(change);
      // Not sent: this page keeps it for itself, over what it read.
      adopt(saved ?? applyLaunchMemory(newest(shared(), useLaunchRecord.getState().record), change));
    } finally {
      useLaunchRecord.setState(state => ({ saving: state.saving.filter(each => each !== change) }));
    }
  });
  line = done.catch(() => {});
  return done;
}
const newest = (shared: LaunchMemory, record: LaunchMemory | null) => record && record.version > shared.version ? record : shared;
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
 * the server for every device (with this screen's saves under way shown over it), and coordinatorStart fills the rest
 * from the AI stack's first row. The server's own switch to a next row when one stops is not a choice: it never writes
 * the memory.
 */
export function useLaunchChoice(conversation?: ConversationLaunch) {
  const offers = agentOffers(useFrameSelector(data => data?.info.profiles) ?? NO_PROFILES);
  const shared = useFrameSelector(data => data?.info.launchMemory) ?? NO_MEMORY;
  const { record, saving } = useLaunchRecord();
  const memory: LaunchMemory = saving.reduce(applyLaunchMemory, newest(shared, record));
  const goesOn = conversation?.previous ? conversation : undefined;
  const own = useConversationChanges(state => goesOn && state.conversation === goesOn.id ? state : null);
  const find = (key: string | null | undefined) => key ? offers.find(item => item.key === key) : undefined;
  // Going on, the agent is the person's pick here, else the conversation's. One the settings no longer enable is never
  // replaced by another: it stays, unavailable, until the person picks again. A new launch's agent is the memory's,
  // else the AI stack's first (the offers' first).
  const current = goesOn ? own?.agent ?? goesOn.agent : null;
  const offer = current ? find(current) : find(memory.agent) ?? offers[0];
  const gone = current && !offer ? current : null;
  const profile = offer?.key ?? gone ?? "";
  const basis = selectionBasis(profile, goesOn, offer ? coordinatorStart(offer.offer, memory.values[profile], offer.initial) : {});
  // What the person changed in the conversation is theirs: checked as chosen, never quietly replaced.
  const changes = own?.agent === profile ? own.changes : {};
  const view = offer ? launchSelection(offer.offer, basis, changes) : { choices: [], shown: {}, send: {}, problems: [] };
  // Once the server has taken a choice, it is the conversation's previous value. Inheriting it lets later messages
  // stay with that conversation if the current message needs another AI.
  const applied = !!own?.agent && goesOn?.agent === own.agent && selectionReady(view) &&
    Object.entries(view.send).every(([key, value]) => goesOn.previous?.[key] === value);
  useEffect(() => {
    if (applied && useConversationChanges.getState() === own)
      useConversationChanges.setState({ conversation: goesOn!.id, agent: null, changes: {} });
  }, [applied, goesOn?.id, own]);
  const change = (target: AgentOffer, update: Values) => {
    if (goesOn) {
      const before = changesFor(goesOn.id);
      // An unsettled change stays until it is chosen again (launchSelection says it), even when another row changes.
      useConversationChanges.setState({ conversation: goesOn.id, agent: target.key,
        changes: { ...(before.agent === target.key ? before.changes : {}), ...update } });
    }
    // The server keeps the last choice for the next new launch, on every device: only the rows chosen now, laid over
    // what it keeps, so a choice made on another device for another row stays.
    rememberLaunch({ kind: "choose", agent: target.key, values: update }, () => shared).catch(sayUnsaved);
  };
  return { profiles: offers, profile, choices: view.choices, selected: view.shown, problems: view.problems,
    /** The agent this send went to, which the settings no longer enable: the person picks another. */
    gone, ready: !gone && selectionReady(view),
    /** A choice made here is still being saved: a send waits for it. */
    saving: saving.length > 0,
    /** What the send carries: null is "none" (a written -). */
    send: view.send,
    sendAgent: goesOn && !own?.agent ? undefined : profile || undefined,
    /** Changes some values; a value the change leaves inactive (the effort of a model without one) is not sent. */
    setSelected: (update: Values) => { if (offer) change(offer, update); },
    chooseProfile: (key: string, overrides: Values = {}) => { const target = find(key); if (target) change(target, overrides); } };
}
export type LaunchChoice = ReturnType<typeof useLaunchChoice>;

/** The launch picker's menu on this screen (the coordinator's input), opened by a new admission that cannot go yet. */
export const useLaunchPicker = create<{ open: boolean }>(() => ({ open: false }));
/**
 * The one check every new admission meets before it fixes a request ID and its selection: not while a choice made here
 * is being saved (the send waits for it), and not ready (selectionReady), the picker opens instead. A request already
 * fixed and sent again keeps its own values and does not come here.
 */
export function admitLaunch(choice: Pick<LaunchChoice, "ready" | "saving"> | null): boolean {
  if (!choice) return true;
  if (choice.saving) return false;
  if (choice.ready) return true;
  useLaunchPicker.setState({ open: true });
  return false;
}

/**
 * The agent chosen in setup (the first enabled one in config order) is where a new launch starts: the remembered
 * agent is let go, and the values kept for each agent stay.
 */
export async function forgetLaunchAgent() {
  useConversationChanges.setState({ conversation: null, agent: null, changes: {} });
  await rememberLaunch({ kind: "forget-agent" }, () => NO_MEMORY);
}
