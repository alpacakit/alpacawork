/** GET /api/runs/:run/steps: every step of one Run, read from its output when the screen opens them. */
import type { Hono } from 'hono';
import { Problem, PROBLEM_CODE } from '@alpacawork/core';
import { isRunMoving, runFolder, type RuntimeRunRecord } from '@alpacawork/contract/run';
import { runIdSchema, type RunId } from '@alpacawork/contract/fields';
import { runtimeAdapter } from '../agents/registry.js';
import { readRunSteps } from '../runs/run-steps.js';

/**
 * `find` reads the Run and refuses a caller who may not read it (its Task's read, or the coordinator's conversation
 * for a Run of no Task); a Run that does not exist is not found.
 */
export function installRunStepsRoutes(api: Hono, root: string, find: (request: Request, run: RunId) => Pick<RuntimeRunRecord, 'id' | 'state' | 'launch'>) {
  api.get('/api/runs/:run/steps', c => {
    const id = runIdSchema.safeParse(c.req.param('run'));
    if (!id.success) throw new Problem(PROBLEM_CODE.notFound, 'Run does not exist', undefined, { reason: { kind: 'run_does_not_exist' } });
    const run = find(c.req.raw, id.data);
    const adapter = runtimeAdapter(run.launch.adapter);
    const ended = isRunMoving(run.state) ? null : run.state === 'succeeded' ? 'done' : 'failed';
    const steps = adapter ? readRunSteps(runFolder(root, run.id), adapter, ended) : { steps: [], older: 0, unread: false };
    return c.json(steps, 200, { 'Cache-Control': 'no-store' });
  });
}
