import { countUse } from '@/features/telemetry/count';
import { useEffect } from "react";
import { useReaderPeople } from "@/data/queries";
import type { Task } from "@/data/types";
import { useTaskReport } from './use-task-report';
import { useReaderCard } from "./next-question";

/** H holds the open task: the same intent as the report's left swipe, written directly. */
export function HoldKey({ task }: { task: Task }) {
  const people = useReaderPeople(task.id);
  const card = useReaderCard();
  const report = useTaskReport(task, people, card);
  const ready = report.ready;
  const holding = ready && task.state !== 'held';
  useEffect(() => {
    const press = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "h" || event.metaKey || event.ctrlKey || event.altKey || event.isComposing ||
          !holding || !(event.target instanceof Element) ||
          event.target.closest("input, textarea, [contenteditable], [role=menu], [role=dialog]")) return;
      event.preventDefault(); if (report.submit('hold').admission !== 'rejected') countUse('key.hold');
    };
    document.addEventListener("keydown", press); return () => document.removeEventListener("keydown", press);
  }, [holding, task, people, card, report]);
  return null;
}
