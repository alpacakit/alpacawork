/**
 * A Run's steps, read from its output when the screen opens them: GET /api/runs/:run/steps?from=&limit= lists them,
 * ?since= gives what changed after a version, and GET /api/runs/:run/steps/:n is what step `n` ran and got back.
 */
import type { Hono } from 'hono';
import { Problem, PROBLEM_CODE } from '@alpacawork/core';
import { isRunMoving, runFolder, RUN_STEPS_PAGE_LIMIT, type RuntimeRunRecord } from '@alpacawork/contract/run';
import { runIdSchema, type RunId } from '@alpacawork/contract/fields';
import { runtimeAdapter } from '../agents/registry.js';
import { runStepIndex } from '../runs/run-steps.js';

const notFound = (what: string) => new Problem(PROBLEM_CODE.notFound, `${what} does not exist`, undefined, { reason: { kind: 'run_does_not_exist' } });
/** A count in the query: absent, or a whole number from 0; anything else is refused as no such step. */
function count(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^(0|[1-9][0-9]{0,8})$/.test(value)) throw notFound('Step');
  return Number(value);
}

/**
 * `find` reads the Run and refuses a caller who may not read it (its Task's read, or the coordinator's conversation
 * for a Run of no Task); a Run that does not exist is not found.
 */
export function installRunStepsRoutes(api: Hono, root: string, find: (request: Request, run: RunId) => Pick<RuntimeRunRecord, 'id' | 'state' | 'launch' | 'cwd'>) {
  const opened = async (request: Request, param: string) => {
    const id = runIdSchema.safeParse(param);
    if (!id.success) throw notFound('Run');
    const run = find(request, id.data);
    const adapter = runtimeAdapter(run.launch.adapter);
    if (!adapter) return null;
    // Once the Run has ended, its output is whole, and what it left running ended with it.
    return runStepIndex(runFolder(root, run.id), run.launch.adapter, adapter,
      isRunMoving(run.state) ? null : run.state === 'succeeded' ? 'done' : 'failed', run.cwd);
  };
  const headers = { 'Cache-Control': 'no-store' };
  api.get('/api/runs/:run/steps', async c => {
    const index = await opened(c.req.raw, c.req.param('run'));
    const since = count(c.req.query('since')), from = count(c.req.query('from')), limit = count(c.req.query('limit')) ?? RUN_STEPS_PAGE_LIMIT;
    if (!index) return c.json({ steps: [], total: 0, version: 0, complete: true, generation: 0 }, 200, headers);
    return c.json(since === undefined ? index.range(from, limit) : index.since(since), 200, headers);
  });
  api.get('/api/runs/:run/steps/:n', async c => {
    const index = await opened(c.req.raw, c.req.param('run'));
    const detail = index ? await index.detail(count(c.req.param('n'))!) : null;
    if (!detail) throw notFound('Step');
    return c.json(detail, 200, headers);
  });
}
