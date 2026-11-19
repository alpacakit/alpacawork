/** Routing preparation owns a separate read snapshot; business transactions always reread their current facts. */
import { setImmediate as nextTurn } from 'node:timers/promises';
import type { ControlReadContext } from './read-context.js';
import { Problem, PROBLEM_CODE } from '@alpacawork/core';
import { RunStore } from '@alpacawork/runs';
import { stateLinksSteps } from './task-reports.js';
import type { RoutingTasks } from './routing-work.js';

export async function prepareRoutingLinks(context: ControlReadContext, work: RoutingTasks,
  shouldYield?: (resumable: boolean) => boolean): Promise<boolean> {
  return context.prepare(async () => {
    const store = new RunStore(context.store.root, { busyTimeoutMs: 1_000 }, true, context.connection);
    const steps = stateLinksSteps({ store,
      runs: { decidingMany: ids => store.readDecisions(reader => reader.decidingMany(ids)) } }, work, context);
    try {
      let since = performance.now();
      for (;;) {
        if (shouldYield?.(true)) throw new Problem(PROBLEM_CODE.busy, 'Returns yielded to a Task write', undefined,
          { reason: { kind: 'returns_yielded_task_write' } });
        const step = steps.next();
        if (step.done) return step.value.links.length > 0;
        if (performance.now() - since >= 4) { await nextTurn(); since = performance.now(); }
      }
    } finally { try { steps.return(undefined as never); } finally { store.close(); } }
  });
}
