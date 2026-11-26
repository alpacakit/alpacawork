import { userTurn } from '@alpacawork/contract';
import type { AnalysisWork } from '@alpacawork/contract/analysis';
import { byTaskNumber } from '@alpacawork/contract/moved';
import { terminal } from '@alpacawork/contract/task-policy';
import type { PublishedFrame } from '../receiver/projection-contract.js';
import type { Slices } from './slices.js';

/** The current work and the user's turn are both read from one published frame. */
export async function activeAnalysisWork(frame: PublishedFrame, allows: (project: string) => boolean, slices: Slices): Promise<AnalysisWork[]> {
  const { records } = frame, shelf = records.shelf(), items: AnalysisWork[] = [];
  for (const id of records.taskIds()) {
    if (slices.due) await slices.pause();
    const meta = records.bundle(id)?.task.meta;
    if (!meta?.analysisSubject || meta.lifecycle !== 'active' || terminal(meta.baseState)) continue;
    const project = records.projectOf(id);
    if (!allows(project) || !shelf.listed.has(project)) continue;
    const reason = userTurn(frame.derived(id)?.ball ?? null)?.reason;
    items.push({ id, title: meta.title, state: meta.state, analysisSubject: meta.analysisSubject,
      userTurn: reason === 'review' || reason === 'question' });
  }
  return items.sort((a, b) => Number(b.userTurn) - Number(a.userTurn) || byTaskNumber(b, a));
}
