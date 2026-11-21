import { useEffect } from "react";
import { userTurn } from "@alpacawork/contract";
import { useHomeList, useTaskIndex } from "@/data/queries";
import { useDeviceValue } from "@/lib/device-storage";
import { useConversation } from "@/features/coordinator/coordinator";
import { guideStage, guideStep, type GuideStep } from "./guide-step";

/**
 * The guide's step for the scope in view, from what the screen already holds: this browser's stage, the Tasks in view,
 * the rows awaiting the person (a question, or a result), and whether the coordinator's conversation has a request from
 * after the guide started. Used where the guide is drawn, so a stage is stored only while it is on the screen.
 */
export function useGuide(tasks: number): GuideStep | null {
  const stage = useDeviceValue(guideStage);
  const index = useTaskIndex();
  const home = useHomeList();
  const since = stage?.stage === "started" ? stage.at : null;
  const sent = useConversation(state => since !== null && !!state.conversation?.turns.some(turn => Date.parse(turn.at) >= since));
  let questions = 0, results = 0;
  for (const row of home.rows) {
    if (row.section !== "review") continue;
    const task = index.byId.get(row.taskId);
    if (task && userTurn(task.ball)?.reason === "question") questions++; else results++;
  }
  const working = home.counts.doing + home.counts.todo + home.counts.awaited;
  const step = guideStep({ stage, tasks, questions, results, working, sent });
  const store = step?.store;
  useEffect(() => { if (store) guideStage.set(store); }, [store?.stage]);
  return step;
}
