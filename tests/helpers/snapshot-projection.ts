/** Translate synthetic input facts to a reader; every screen rule is the production projection's. */
import type { ControlTreeDTO, ProjectionVersion, HistoryWindowRequest } from '@alpacawork/contract/control';
import { fieldCatalog, type TaskValues } from '@alpacawork/contract';
import { record } from '../runs-fixtures.ts';
import { bundle, FakeRecords } from './projection-read-fixture.ts';
import { deriveTask } from '@alpacawork/backend/test-dist/receiver/screen-derive.js';
import { createScreenAggregate } from '@alpacawork/backend/test-dist/receiver/screen-aggregate.js';
import { aggregateFactsOf } from '@alpacawork/backend/test-dist/receiver/workspace-aggregate-facts.js';
import { ProjectedHistory, projectedView } from '@alpacawork/backend/test-dist/receiver/task-reads.js';
import { composeRow, liveRow } from '@alpacawork/backend/test-dist/receiver/index-rows.js';
import { ProjectedPages } from '@alpacawork/backend/test-dist/receiver/index-pages.js';
import { readAgentsSettings } from '@alpacawork/backend/test-dist/agents-settings.js';
import { seatSettings } from '@alpacawork/backend/test-dist/control/wake.js';
import type { PublishedFrame, TaskBundle } from '../../apps/backend/src/receiver/projection-contract.js';

export function snapshotFrame(tree: ControlTreeDTO, pv: ProjectionVersion): PublishedFrame {
  const items: TaskBundle[] = tree.tasks.map(task => {
    const base = bundle(task.id, task.parentId ?? undefined);
    const placements = tree.placements.filter(item => item.taskId === task.id);
    const runs = tree.runs.filter(run => run.taskId === task.id).map(run => record(run.id, {
      task: task.id, placementId: run.placementId, requestId: run.requestId, agent: run.agent,
      role: (tree.historyFacts.runRoles[run.id] ?? tree.historyFacts.placementRoles[run.placementId]
        ?? (placements.find(item => item.id === run.placementId)?.responsible ? 'owner' : 'member')) === 'owner' ? 'owner' : 'worker',
      caller: run.caller, resumes: run.resumes, continues: false, session: run.session, cwd: run.cwd,
      launch: { ...record().launch, values: run.launchValues }, state: run.state, reason: run.reason, into: run.into,
      pids: { manager: null, agent: run.processStarted ? 1234 : null },
      created_at: run.createdAt, started_at: run.startedAt, ended_at: run.endedAt,
      usage: run.usage ? { conversation: null, ...run.usage } : null }));
    return { ...base, task: { ...base.task, path: task.path, hash: task.hash, settings: task.settings ?? null,
      values: (tree.taskValues[task.id] ?? task.values) as TaskValues, meta: { ...base.task.meta, ...task,
        baseState: task.state === 'held' ? task.baseState : task.state, hold: task.state === 'held', version: BigInt(task.version) } },
      placements: placements.map(item => ({ ...item, endedAt: item.endedAt ?? null, responsible: tree.historyFacts.placementRoles[item.id] === 'owner' || item.responsible })),
      runs, runFiles: new Map(tree.runs.filter(run => run.taskId === task.id).map(run => [run.id, { activity: run.activity, errorCause: run.errorCause }])),
      headRunIds: new Map(placements.map(item => [item.id, item.headRunId])),
      requests: tree.requests.filter(request => request.taskId === task.id).map(request => ({ ...request, author: request.author!, placementRevision: 1,
        taskHash: task.hash, waitCycleId: null, headRunId: null, aboutRunId: request.aboutRunId ?? null, runId: request.runId ?? null })),
      dialogues: tree.dialogues.filter(dialogue => dialogue.taskId === task.id),
      answerTexts: tree.historyFacts.answerTexts, requestedByUser: tree.requestedByUser[task.id] ?? null,
      after: tree.startOrder?.[task.id]?.after.map(item => item.task) ?? [],
      returns: tree.historyFacts.deliveries.filter(item => item.toTaskId === task.id).map((item, n) => ({ id: `return-${n}`,
        requestId: null, outcome: item.outcome, toTaskId: item.toTaskId, causeLogId: item.logId,
        boundaryRunId: null, holdReason: null, holdProblemReason: null, createdAt: '2026-01-01T00:00:00.000Z', resolution: null,
        deliveries: [{ wakeRequestId: item.requestId, reservedAt: '2026-01-01T00:00:00.000Z', receivedAt: null, releasedAt: null, releaseReason: null,
          consumedAt: item.consumed ? '2026-01-01T00:00:00.000Z' : null }] })) };
  });
  for (const parent of new Set(items.map(item => item.task.meta.parentId)))
    if (parent && !items.some(item => item.task.id === parent)) items.push(bundle(parent));
  const records = new FakeRecords(items, pv);
  records.seatSettings = () => seatSettings(readAgentsSettings(tree.root));
  records.environment = () => tree;
  records.catalog = () => fieldCatalog(tree.fieldCatalog);
  records.schemaOf = (id?: string) => {
    const schema = tree.projectSchemas[id!] ?? records.schema;
    return { fields: [...schema.fields], from: schema.from ?? null };
  };
  records.coordinatorRun = (id?: string) => tree.historyFacts.coordinatorRuns[id!];
  const values = new Map([...records.taskIds()].map(id => [id, deriveTask(records, id)]));
  const aggregate = createScreenAggregate([...values.values()].map(value => value.contribution),
    new Map([...values].map(([id, value]) => [id, aggregateFactsOf(records, id, value.row, null)])));
  return { generation: 'snapshot', pv, applied: 0 as PublishedFrame['applied'], records, derived: id => values.get(id), aggregate,
    requiredPv: { view: {}, history: {}, page: {}, search: {}, timeline: {} }, patch: null };
}

/** Read-only adapter for authored History/timeline scenarios; no legacy rules or derived values are accepted. */
export function snapshotReads() {
  let point: PublishedFrame, version = 0;
  let histories: ProjectedHistory, pages: ProjectedPages;
  return {
    update(tree: ControlTreeDTO) {
      point = snapshotFrame(tree, ++version as ProjectionVersion);
      histories = new ProjectedHistory(); pages = new ProjectedPages();
    },
    view: (id: string) => projectedView(point, id),
    history: (id: string, request: HistoryWindowRequest = { mode: 'latest' }) => histories.read(point, id, request),
    row: (id: string) => liveRow(composeRow(point.derived(id)!, point.aggregate)),
    finished: (parent: string | null, scope: string | null) => pages.page(point, 'finished', parent, scope),
    search: (text: string, scope: string | null) => pages.search(point, text, scope),
    timeline: (input: Parameters<ProjectedPages['timeline']>[1]) => pages.timeline(point, input),
    timelineAxis: (input: Parameters<ProjectedPages['timelineAxis']>[1]) => pages.timelineAxis(point, input),
  };
}
