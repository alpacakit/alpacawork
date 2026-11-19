/**
 * A test's read of one project's control tree (or the whole workspace's) in one read point: every Task with its Runs,
 * placements, Requests, returns, balls and start orders, made by the shared rules over an eager seat source. Tests
 * read business outcomes through it; serve projects the same records Task by Task (receiver/screen-derive).
 */
import { controlReplySchema, controlRequestSchema, controlTreeSchema,
  type ControlReplyDTO, type ControlRequestDTO, type ControlTreeDTO } from '@alpacawork/contract/control';
import type { ControlTask } from '@alpacawork/raw';
import { RunStore } from '@alpacawork/runs';
import { compareRunIds, hasContinuableSession, type ReadRunRecord } from '@alpacawork/contract/run';
import { PROBLEM_CODE, hasCode, faultReason, type Problem, type ProblemReason } from '@alpacawork/core';
import { dependencyStatuses } from '@alpacawork/backend/test-dist/control/dependencies.js';
import { TaskRepository, TaskTree, controlSnapshotView, readControl } from '@alpacawork/backend/test-dist/control/task-store.js';
import { readAgentsSettings } from '@alpacawork/backend/test-dist/agents-settings.js';
import { workingOf } from '@alpacawork/backend/test-dist/control/working.js';
import { ballSourceOf, ballsOf } from './ball-source.ts';
import { endedOwnWork } from '@alpacawork/backend/test-dist/control/return-rules.js';
import { seatSettings, seatSourceOf } from '@alpacawork/backend/test-dist/control/wake.js';
import { tasksSchema } from '@alpacawork/backend/test-dist/control/task-values-store.js';
import { taskFiles, type TaskFileIndex } from '@alpacawork/backend/test-dist/control/task-files.js';
import { FileWriter } from '@alpacawork/backend/test-dist/raw/storage.js';
import { coordinatorRunsOf, dialoguesOf, markMessages, requestedByUser, saidAt } from '@alpacawork/backend/test-dist/coordinator/messages.js';
import { controlRuns, projectPlacements, readControlEnvironment } from '@alpacawork/backend/test-dist/control/tree.js';

type ReadError = { code: string; message: string; path: string; reason?: ProblemReason };
const runsUnavailable = (error: Problem): ReadError =>
  ({ code: PROBLEM_CODE.runsUnavailable, message: error.message, reason: error.reason ?? faultReason(error), path: '.alpacawork/alpacawork.sqlite' });

/**
 * What the screen reads of the Tasks besides their records, in one read: the fixed texts of the answers to their
 * questions, their dialogues with a coordinator (messages.dialoguesOf), and when the user asked for each Task they asked for
 * (messages.requestedByUser).
 */
function readWords(root: string, tasks: readonly ControlTask[], requests: readonly ControlRequestDTO[]):
  Pick<ControlTreeDTO, 'dialogues' | 'requestedByUser'> & Pick<ControlTreeDTO['historyFacts'], 'answerTexts' | 'coordinatorRuns'> {
  const answered = tasks.flatMap(task => task.meta.log.filter(entry => entry.kind === 'answered').map(entry => entry.id));
  return readControl(root, db => {
    const said = saidAt(db, markMessages(tasks.map(task => task.meta.log)));
    const texts = new Map(db.prepare(`SELECT log_id, text FROM log_texts
      WHERE log_id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(answered))
      .map(row => [String(row.log_id), String(row.text)]));
    const dialogues = dialoguesOf(db, tasks);
    // The screen messages these records name: a dialogue's own, and the one a Coordinator's record or Request was written on.
    const messages = [...dialogues.map(dialogue => dialogue.messageId),
      ...tasks.flatMap(task => task.meta.log.flatMap(entry => entry.actor.kind === 'main' && entry.actor.message ? [entry.actor.message] : [])),
      ...requests.flatMap(request => request.author.kind === 'main' && request.author.message ? [request.author.message] : [])];
    return {
      answerTexts: Object.fromEntries(answered.flatMap(id => texts.has(id) ? [[id, texts.get(id)!]] : [])),
      coordinatorRuns: coordinatorRunsOf(db, messages),
      dialogues,
      requestedByUser: Object.fromEntries(tasks.flatMap(task => {
        const requested = requestedByUser(task.meta.log, message => said.get(message));
        return requested ? [[task.id, requested]] : [];
      })),
    };
  });
}

/**
 * One project's tree in one read: the Tasks that belong to `project` with every project Task (the settings and the
 * paths they inherit), and their Runs, placements, Requests, returns and balls. Without `project`, the whole
 * workspace's. Each Task's log carries its questions, answers, withdrawals and urgent reports; a stop expires the
 * questions asked before it.
 */
export async function readControlTree(root: string,
  { project, source, fileIndex, checked = true }: { project?: string; source?: () => RunStore; fileIndex?: TaskFileIndex;
    /** Off, the finished tree is not checked against its contract again. Every part of it was read through its own schema. */
    checked?: boolean } = {}):
  Promise<ControlTreeDTO> {
  {
  const point = readControl(root, db => {
    const taskSnapshot = new TaskRepository(root, db).snapshot(project);
    const startOrder = Object.fromEntries([...dependencyStatuses(db, taskSnapshot.tasks.map(task => task.id))]
      .filter(([, order]) => order.after.length));
    const store = source ? source() : new RunStore(root, { busyTimeoutMs: 0 }, true, db);
    try {
      const snapshot = store.snapshot(project);
      return { taskSnapshot, snapshot, startOrder };
    } finally { if (!source) store.close(); }
  });
  const { taskSnapshot, snapshot, startOrder } = point;
  const tasks = controlSnapshotView(taskSnapshot);
  const runError = snapshot.runError ? runsUnavailable(snapshot.runError) : null;
  const records: readonly ReadRunRecord[] | null = runError ? null : snapshot.records ?? [];
  const runs = controlRuns(root, records ?? []);
  const replies: Record<string, ControlReplyDTO> = {};
  if (records) {
    const latest = new Map<string, ReadRunRecord>();
    for (const run of [...records].sort(compareRunIds))
      if (run.role === 'owner' && endedOwnWork(run.state)) latest.set(run.task, run);
    for (const [taskId, run] of latest) {
      const state = snapshot.resultStates.get(run.id) ?? 'missing';
      replies[taskId] = controlReplySchema.parse({ runId: run.id,
        state: state === 'pending' ? 'missing' : state });
    }
  }
  const runById = new Map<string, ReadRunRecord>((records ?? []).map(run => [run.id, run]));
  const requests: ControlRequestDTO[] = snapshot.requests.map(saved => {
    const run = saved.runId ? runById.get(saved.runId) : undefined;
    return controlRequestSchema.parse({
      id: saved.id, taskId: saved.taskId, placementId: saved.placementId, runId: saved.runId,
      recipientRole: run?.task === saved.taskId && run.placementId === saved.placementId ? run.role : null,
      aboutRunId: saved.aboutRunId, purpose: saved.purpose, author: saved.author, mode: saved.mode,
      body: saved.body, submittedAt: saved.submittedAt, deliveryState: saved.deliveryState,
    });
  });
  const placements = projectPlacements(root, snapshot.placements, tasks.tasks, records === null ? null : runs)
    .map(placement => {
      const headRunId = snapshot.headRunIds.get(placement.id) ?? null;
      const head = headRunId ? runById.get(headRunId) : null;
      return { ...placement, headRunId,
        ...(records === null || headRunId && !head ? {} : { previousValues: head && hasContinuableSession(head) ? { ...head.launch.values } : null }) };
    });
  const settings = readAgentsSettings(root);
  // Unread Runs leave no ball to derive; their read error in `errors` tells that from a tree where none is awaited.
  const ballSource = records ? ballSourceOf(seatSourceOf(taskSnapshot.tasks, snapshot, seatSettings(settings)), taskSnapshot.tasks) : null;
  const balls = ballSource ? ballsOf(ballSource) : {};
  const working = workingOf(records);
  const environment = readControlEnvironment(root, settings);
  // Each project Task's effective schema and where it came from, from the Tasks this read holds.
  const owners = new TaskTree(taskSnapshot.tasks);
  const projectSchemas = Object.fromEntries(taskSnapshot.tasks.filter(task => task.meta.kind === 'project')
    .map(task => { const { fields, from } = tasksSchema(owners, taskSnapshot.fields.schemas, task.id); return [task.id, { fields: [...fields], from }]; }));
  let fileTasks = tasks.tasks.map(view => ({ ...view, files: [] as ControlTreeDTO['tasks'][number]['files'] }));
  try {
    const writer = new FileWriter(root);
    try {
      const folders = tasks.tasks.map(view => view.path);
      const files = fileIndex ? fileIndex.read(writer, folders) : taskFiles(writer, folders);
      fileTasks = tasks.tasks.map(view => ({ ...view, files: files.get(view.path) ?? [] }));
    }
    finally { writer.close(); }
  } catch (error) {
    // A synthetic root can disappear after the Task scan during server shutdown.
    if (!hasCode(error, 'ENOENT')) throw error;
  }
  const { answerTexts, coordinatorRuns, ...words } = readWords(root, taskSnapshot.tasks, requests);
  const historyFacts: ControlTreeDTO['historyFacts'] = {
    answerTexts,
    placementRoles: Object.fromEntries(snapshot.placements.map(placement => [placement.id, placement.responsible ? 'owner' : 'member'])),
    runRoles: Object.fromEntries([...runById].map(([id, run]) => [id, run.role === 'owner' ? 'owner' : 'member'])),
    deliveries: snapshot.returns.flatMap(row => row.causeLogId === null ? [] : row.deliveries
      .map(delivery => ({ logId: row.causeLogId!, toTaskId: row.toTaskId, requestId: delivery.wakeRequestId, outcome: row.outcome,
        consumed: delivery.consumedAt !== null }))),
    coordinatorRuns,
  };
  const tree: ControlTreeDTO = { root: tasks.root, tasks: fileTasks,
    errors: [...environment.errors, ...(runError ? [runError] : [])],
    writable: environment.writable && runError === null,
    placements, runs, requests, replies, balls, working,
    ...words, historyFacts, profiles: environment.profiles, attachmentBytes: environment.attachmentBytes,
    fieldCatalog: [...taskSnapshot.fields.catalog.values()], projectSchemas,
    taskValues: Object.fromEntries(taskSnapshot.tasks.map(task => [task.id, task.values])), startOrder };
  // Checked or not, the same object in the same key order: a screen's rows are compared as text.
  if (checked) controlTreeSchema.parse(tree);
  return tree;
  }
}
