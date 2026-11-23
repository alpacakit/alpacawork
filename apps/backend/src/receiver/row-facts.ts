import { TASK_POLICY, evaluate } from '@alpacawork/contract/task-policy';
/** Row facts: runtime and state times, attention beside another Run, and the kind of the reader's turn.
 * The index projects them for every row, including closed pages; the screen only words and clocks them. */
import { userTurn } from '@alpacawork/contract';
import { currentTransition, type ControlRunDTO, type PlacementDTO, type RowFacts, type TaskRowDTO } from '@alpacawork/contract/control';
import type { ScreenAggregate, TaskDerived } from './projection-contract.js';

type RowTask = Pick<TaskRowDTO, 'id' | 'state' | 'stateLog' | 'ball' | 'question'>;
type StateEntry = RowTask['stateLog'][number] | null;

const earliest = (times: (string | null)[]) => times.filter((at): at is string => !!at).map(Date.parse).sort((a, b) => a - b)[0] ?? null;

function statusOf(task: RowTask, own: readonly PlacementDTO[], runs: readonly ControlRunDTO[], warning: RowFacts['warning'], kind: RowFacts['kind'], error: StateEntry, runningBelow: number, workingBelow: number): Omit<RowFacts, 'kind' | 'runningRuns' | 'position'> {
  const facts = (status: RowFacts['status']): Omit<RowFacts, 'kind' | 'runningRuns' | 'position'> =>
    ({ status, childrenRunning: runningBelow, warning });
  // Runtime's attention can coexist with a running Run; its counts retain that fact.
  const running = own.some(placement => placement.runtime.runningCount > 0);
  const moving = runs.filter(run => run.state === 'running' && own.some(placement => placement.id === run.placementId));
  const transition = currentTransition(task);
  const reasonAt = kind?.kind === 'stopped' ? error?.causeAt ?? error?.at
    : kind?.kind === 'followup' ? userTurn(task.ball)?.at : null;
  const since = reasonAt ?? transition?.causeAt ?? transition?.at ?? null;
  const result = evaluate(TASK_POLICY.rowStatus, { state: task.state, running, troubled: warning !== null,
    queued: own.some(placement => placement.runtime.queuedCount > 0), below: workingBelow, since: since !== null, reason: !!reasonAt });
  switch (result.code) {
    case 'own_running': return facts({ kind: 'running', since: earliest(moving.map(run => run.startedAt)) });
    case 'runtime_unclear': return facts({ kind: 'unclear' });
    case 'queued': return facts({ kind: 'queued' });
    case 'not_started': return facts(null);
    case 'state_since': return facts({ kind: 'since', at: Date.parse(since!) });
    case 'no_status': return facts(null);
    default: throw new Error('Unlisted row status');
  }
}

/**
 * What waits on the reader, or why it stopped, as one word on the row: a stopped run's reason, else the kind of the
 * user's turn the ball says (a question, a review, or another reason, written out).
 * Null when neither.
 */
function kindOf(task: RowTask, runs: readonly ControlRunDTO[], error: StateEntry): RowFacts['kind'] {
  const turn = userTurn(task.ball), result = evaluate(TASK_POLICY.rowMeaning, { state: task.state, turn });
  switch (result.code) {
    case 'failure': {
      const run = runs.find(run => run.id === error?.runId);
      const errorCause = run?.availability ?? run?.errorCause;
      return { kind: 'stopped', failure: errorRunReason(run), ...errorCause ? { errorCause } : {} };
    }
    case 'question': return { kind: 'question' };
    case 'review': return { kind: 'review' };
    case 'user_followup': return { kind: 'followup', turn: turn! };
    case 'none': return null;
    default: throw new Error('Unlisted row meaning');
  }
}

/** The error record's Run is authoritative for both the row and its History event. */
export const errorRunReason = (run: ControlRunDTO | undefined): string =>
  run?.state === 'succeeded' ? 'no_report' : run?.state === 'cancelled' ? 'stopped' : run?.reason ?? 'unknown';

/** A row's facts as the index sends them: its own (projectRowFacts) with what the aggregate decides, its descendants' work and its position. */
export const aggregateRowFacts = ({ id, row, placements, runs }: TaskDerived, aggregate: ScreenAggregate): RowFacts =>
  ({ ...projectRowFacts(row, placements, runs, aggregate.children(id)?.runningBelow ?? 0, aggregate.workingBelow(id), aggregate.runningRuns(id)),
    position: aggregate.position(id) });

/** The one projection of a row's operational facts; no work prose determines its status. */
export function projectRowFacts(task: RowTask, placements: readonly PlacementDTO[], runs: readonly ControlRunDTO[], runningBelow: number, workingBelow: number, runningRuns: number): Omit<RowFacts, 'position'> {
  const own = placements.filter(placement => placement.taskId === task.id && placement.active);
  const reviewing = runs.find(run => run.state === 'needs_review' && own.some(placement => placement.id === run.placementId));
  const result = evaluate(TASK_POLICY.rowWarning, { unknown: own.some(placement => placement.runtime.displayState === 'unknown'),
    reviewing: !!reviewing, reason: reviewing?.reason ?? null });
  const warning = result.code === 'none' ? null : result.code as NonNullable<RowFacts['warning']>;
  const error = currentTransition({ state: 'error', stateLog: task.stateLog });
  const kind = kindOf(task, runs, error);
  return { ...statusOf(task, own, runs, warning, kind, error, runningBelow, workingBelow), runningRuns, kind };
}
