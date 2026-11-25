/** Explicit execution and state facts for in-memory index fixtures. */
import type { ControlTreeDTO } from '@alpacawork/contract/control';
import { isUnfinished } from '@alpacawork/runs';
import type { RunState } from '@alpacawork/contract/run';

/** The Tasks with their own unfinished Run (runs isUnfinished). Returns and incoming Requests are not Runs. */
export function workingOf(records: readonly { task: string; state: RunState }[] | null): string[] | null {
  return records === null ? null : [...new Set(records.filter(isUnfinished).map(run => run.task))];
}
export function fixtureWorkingTree<Tree extends ControlTreeDTO>(tree: Tree): Tree {
  return { ...tree,
    tasks: tree.tasks.map(task => ({ ...task, baseState: task.state === 'held' ? task.baseState : task.state, hold: task.state === 'held' })),
    working: workingOf(tree.runs.map(run => ({ task: run.taskId, state: run.state }))),
  };
}
