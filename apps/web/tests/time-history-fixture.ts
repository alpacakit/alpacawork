import type { Task } from "../src/data/types";
import { timelineNoteOf } from "@alpacawork/contract/control";
import type { TimelineNote } from "../src/domain/history";
import type { PeopleIndex } from "../src/domain/people";
import { projectTimeHistory, timeHistoryBase } from "../src/domain/time-history";
import { reportDisplay, reportEvent, turnRecord } from "../src/domain/report-events";
import { eventKey } from "../src/domain/history";
import { fixtureHistory } from "./fixtures";

/** Marks projected from the fixture's raw History; index rows intentionally omit the report details. */
export const recordNotes = (people: PeopleIndex, taskId: string, only?: readonly string[]): TimelineNote[] => {
  const events = (fixtureHistory.get(people)?.[taskId] ?? []).filter(event => !only || only.includes(event.id));
  const display = reportDisplay(events.map(event => reportEvent(event, id => turnRecord(people.tasks.get(id)))));
  return events.map(event => ({ ...timelineNoteOf(event),
    ...(display.targets.get(eventKey(event)) !== eventKey(event) ? { displayed: false } : {}) }));
};
/** Test shorthand for the same two stages the screen uses, with every record of the task's row as a note. */
export const timeHistory = (task: Task, people: PeopleIndex, now: number) =>
  projectTimeHistory(timeHistoryBase(task, people, recordNotes(people, task.id)), now);
