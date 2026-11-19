/** A routing seat source admits only the work set's seats, with related Tasks available for ancestry and closures. */
import type { TaskDecisionFacts } from './routing-facts.js';
import type { RunTransaction } from '@alpacawork/runs';
import type { ReturnLifecycle } from './return-lifecycle.js';
import type { RoutingTasks } from './routing-work.js';
import { seatSourceIn as transactionSeats, type SeatSource, type seatSettings } from './wake.js';

export function seatSourceIn(runs: RunTransaction, work: RoutingTasks, tasks: readonly TaskDecisionFacts[],
  settings: ReturnType<typeof seatSettings>, held: ReturnLifecycle['current']): SeatSource {
  const byId = new Map(tasks.map(task => [task.id, task]));
  let project = tasks.find(task => work.tasks.has(task.id));
  while (project && project.meta.kind !== 'project') project = byId.get(project.meta.parentId ?? '');
  // All set reads use `held`, already read on this write's connection. Head and input reads remain live transaction reads.
  const source = transactionSeats(runs, project?.id ?? '', tasks, settings, held);
  return { ...source,
    responsible: id => work.tasks.has(id) ? source.responsible(id) : null,
    returnsTo: id => work.tasks.has(id) ? source.returnsTo(id) : [],
    openSent: id => work.tasks.has(id) ? source.openSent(id) : [],
  };
}
