/** Explicit execution and state facts for in-memory index fixtures. */
import type { ControlTreeDTO } from '@alpacawork/contract/control';
import { workingOf } from '@alpacawork/backend/test-dist/control/working.js';
export function fixtureWorkingTree<Tree extends ControlTreeDTO>(tree: Tree): Tree {
  return { ...tree,
    tasks: tree.tasks.map(task => ({ ...task, baseState: task.state === 'held' ? task.baseState : task.state, hold: task.state === 'held' })),
    working: workingOf(tree.runs.map(run => ({ task: run.taskId, state: run.state }))),
  };
}
