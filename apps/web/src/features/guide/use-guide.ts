import { useEffect, useMemo } from "react";
import { userTurn } from "@alpacawork/contract";
import { useHomeList, useListPlace, useTaskIndex, useWorkspaceInfo } from "@/data/queries";
import { useDeviceValue } from "@/lib/device-storage";
import { useViewStore } from "@/state/view-store";
import { useConversation } from "@/features/coordinator/coordinator";
import { useInputDraft } from "@/features/coordinator/editor/draft";
import { answersIn, hasContent } from "@/features/coordinator/editor/document";
import { outgoing } from "@/features/coordinator/editor/outbox";
import { useDraftStore } from "@/features/forms/draft-store";
import { guideStage } from "./guide-state";
import { guideEntry, nextStage, type GuideEntry, type GuideFacts } from "./guide-definition";

const NONE: ReadonlySet<string> = new Set();
/** A message of the conversation not answered yet: waiting its turn, being handed over, or being worked on. */
const UNDER_WAY = new Set(["queued", "sending", "joined", "running"]);

/**
 * The guide's step for the scope in view (guide-definition.ts), from what the screen already holds: this browser's
 * stage, the Tasks in view, the rows awaiting the person (a question, or a report) and those still worked on, whether the
 * coordinator's conversation has a request from after the guide started, and whether the Task open in the detail is the
 * person's turn. Null: no guide (never started, or over).
 */
export function useGuide(): GuideEntry | null {
  const stage = useDeviceValue(guideStage);
  const index = useTaskIndex();
  const home = useHomeList();
  const project = useViewStore((state) => state.project);
  const tasks = useWorkspaceInfo((info) => info.counts.tasks[project ?? "root"] ?? 0);
  const selected = useViewStore((state) => state.reader.open ? state.selected : null);
  const since = stage?.stage === "started" ? stage.at : null;
  const sentBefore = useConversation(state => since !== null && !!state.conversation?.turns.some(turn => Date.parse(turn.at) >= since));
  let questions = 0, results = 0;
  for (const row of home.rows) {
    if (row.section !== "review") continue;
    const task = index.byId.get(row.taskId);
    if (task && userTurn(task.ball)?.reason === "question") questions++; else results++;
  }
  const working = home.counts.doing + home.counts.todo + home.counts.awaited;
  const opened = selected ? index.byId.get(selected) : undefined;
  const turn = opened ? userTurn(opened.ball)?.reason : undefined;
  const open = turn === "question" ? "question" : turn === "review" ? "result" : null;
  // What the coordinator has from the person and is still on: sent from here and not settled (its grace, "about to
  // send", included), or a message of the conversation not answered yet.
  const root = useConversation(state => state.root);
  const pending = useDraftStore(state => outgoing(state.entries, root)
    .filter(item => !item.taken && !item.cancelled && item.stage !== "refused").map(item => item.requestId).join(" "));
  const unsettled = useConversation(state => !!pending && pending.split(" ").some(id => !state.conversation?.turns.some(turn => turn.id === id)));
  const answering = useConversation(state => !!state.conversation?.turns.some(turn => UNDER_WAY.has(turn.status)));
  const busy = unsettled || answering;
  // What the input holds now: anything to send, and an answer to the Task open in the detail.
  const { doc } = useInputDraft();
  const drafting = hasContent(doc);
  const answerDrafted = !!opened && answersIn(doc, opened.id).length > 0;
  const seen = useMemo(() => stage && stage.stage !== "done" ? new Set(stage.seen) : NONE, [stage]);
  if (!stage || stage.stage === "done") return null;
  // Sent: in the conversation since the guide started, or sent from here and not in it yet (in its grace, or on its way).
  const sent = since !== null && (sentBefore || unsettled);
  const facts: GuideFacts = { stage, tasks, questions, results, working, sent, busy, drafting, answerDrafted, open, seen };
  return guideEntry(facts);
}

/**
 * Stores the stage as the guide moves (nextStage). Mounted once, beside the balloon, so a stage is written by one owner
 * only; it starts the guide only while an empty scope's welcome is on the screen.
 */
export function useGuideStage(entry: GuideEntry | null) {
  const stage = useDeviceValue(guideStage);
  const welcome = useListPlace() === "welcome";
  const next = nextStage(stage, welcome, entry);
  useEffect(() => { if (next) guideStage.set(next); }, [next?.stage]);
}
