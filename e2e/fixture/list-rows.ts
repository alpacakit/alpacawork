/** Explicit list layouts for interaction tests. Prepare before serve starts; the ordinary sample stays hierarchical. */
import { ControlStore } from '@alpacawork/db';
import { decideValues } from '../../tests/helpers/task-values.ts';
import { patchTask, seedQuestion } from './task-state.ts';
import { SAMPLE_NOW } from './sample.ts';

/** These scenarios need their own rows independently of a parent's work or a user turn. */
export function projectRows(root: string, ids: readonly string[]): void {
  const store = new ControlStore(root);
  try {
    store.write(db => {
      for (const id of ids) {
        // A top Task has a row regardless of userRequested; keep its original mark and immutable history.
        const changed = db.prepare("UPDATE tasks SET parent_id=project_task_id WHERE external_id=? AND kind='task'").run(id);
        if (!changed.changes) throw new Error(`Missing list fixture Task ${id}`);
      }
    });
  } finally { store.close(); }
}

/** Preserve a real child and its breadcrumb while making its user-turn row available. */
export function questionRow(root: string, id: string): void {
  patchTask(root, id, { state: 'doing', values: decideValues('Review this part of the work') });
  seedQuestion(root, id, { to: 'user', at: SAMPLE_NOW, title: 'Review this part of the work' });
}
