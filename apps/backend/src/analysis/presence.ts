/**
 * Whether the user was there while a task waited for them. The user's actions on every task (instructions, answers,
 * acceptances and the like, theirs or the coordinator's for them, and their messages to the coordinator) are laid in
 * one line; a gap of 30 minutes or more with no action is time away, as web analytics end a session after 30 idle
 * minutes. A shorter gap counts toward the task the next action was on: this task's turn when it was on this task (or
 * under it), time spent on other tasks when it was elsewhere. After the last action, the gap runs to now.
 */
import type { Interval } from './rules.js';

export const AWAY_MS = 30 * 60_000;
/** One action of the user, at a time, on a task (by ID), or on none that the record names (a message to the coordinator). */
export type Activity = { at: number; task: string | null };
export type WaitSplit = { away: number; otherTasks: number; thisTask: number };
export const emptySplit = (): WaitSplit => ({ away: 0, otherTasks: 0, thisTask: 0 });

/** The first index whose action is after `time` (`activity` is in time order). */
function after(activity: readonly Activity[], time: number) {
  let low = 0, high = activity.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (activity[middle]!.at <= time) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** The waits (in time order, not overlapping) split by where the user was. `here`: whether a task is this one or under it. */
export function splitWaits(waits: readonly Interval[], activity: readonly Activity[], here: (task: string) => boolean,
  now: number): WaitSplit {
  const split = emptySplit();
  for (const wait of waits) {
    let index = after(activity, wait.from), cursor = wait.from;
    let previous = index > 0 ? activity[index - 1]!.at : -Infinity;
    while (cursor < wait.to) {
      const next = index < activity.length ? activity[index]!.at : null;
      const end = Math.min(wait.to, next ?? wait.to);
      let onThis = false;
      while (index < activity.length && activity[index]!.at === next) {
        const task = activity[index++]!.task;
        if (task !== null && here(task)) onThis = true;
      }
      const part = (next ?? now) - previous >= AWAY_MS ? 'away' : next === null || onThis ? 'thisTask' : 'otherTasks';
      split[part] += end - cursor;
      cursor = end;
      if (next !== null) previous = next;
    }
  }
  return split;
}

export const addSplit = (total: WaitSplit, part: WaitSplit) => {
  total.away += part.away; total.otherTasks += part.otherTasks; total.thisTask += part.thisTask;
};
