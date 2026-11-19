import type { HistoryEventKind } from './history-events.js';
import type { TaskState } from '@alpacawork/raw/task-enums';

/** What a placement reported, asked or commented is a card; every other record is a quiet row. */
const CARDS: ReadonlySet<HistoryEventKind> = new Set(["report", "review", "question", "urgent", "comment"]);
/**
 * A card's mark, coloured by what it set: done, a review or a question that waits (quiet), or work going on. A record
 * without a title has no card. `kind` is the record's event (contract eventOf for a log entry).
 */
export function reportMark(record: { kind: HistoryEventKind | null; state: TaskState | null; title: string | null }): { kind: "report"; tone: "done" | "quiet" | "working" } | null {
  if (!record.kind || !CARDS.has(record.kind) || !record.title?.trim()) return null;
  return { kind: "report", tone: record.state === "done" ? "done" : record.state === "waiting" || record.kind === "question" ? "quiet" : "working" };
}

