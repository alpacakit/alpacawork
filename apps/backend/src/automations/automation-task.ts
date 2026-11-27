import { randomUUID } from 'node:crypto';
import type { AiRow } from '@alpacawork/contract';
import { tasksIn, type ControlTx } from '../control/task-transition.js';
import { ControlTaskCommands } from '../control/task-commands.js';
import { PlacementCommands } from '../control/placement-commands.js';
import { RequestService } from '../control/requests.js';
import type { BundleAutomation } from './bundle-store.js';

export function createAutomationTaskAndRequest(tx: ControlTx, automation: Pick<BundleAutomation, 'id' | 'revision' | 'project' | 'name'>,
  options: { number: number; digest?: string; trial: boolean; title: string; awaitReview: boolean; ai: readonly AiRow[]; body: (taskId: string) => string }) {
  const { root, connection } = tx.store;
  const reference = { automationId: automation.id, revision: automation.revision, runNumber: options.number };
  const actor = { kind: 'automation' as const, ...reference };
  const task = ControlTaskCommands.createAutomationTask(tx, {
    project: automation.project, title: options.title,
    origin: { ...reference, ...(options.digest ? { digest: options.digest } : {}), name: automation.name, ...(options.trial ? { trial: true } : {}) },
    awaitReview: options.awaitReview,
  });
  const aiStack = [...options.ai, 'stop' as const];
  const { placement } = new PlacementCommands(root).placeNewResponsibleIn(tx, {
    taskId: task.id, expectedTaskHash: task.hash, aiStack, selected: options.ai[0]!.values,
  }, actor);
  const placed = tasksIn(tx).get(task.id);
  const firstRequestId = randomUUID();
  new RequestService(root).requestIn({
    taskId: task.id, body: options.body(task.id), requestId: firstRequestId, expectedTaskHash: placed.hash,
    expectedPlacementRevision: placement.revision, aiStack,
  }, { purpose: 'instruction', actor }, connection);
  return { task: tasksIn(tx).get(task.id), firstRequestId };
}

export const taskOriginForRun = (automation: string, number: string) => `l.ordinal=0 AND json_extract(l.entry,'$.actor.kind')='automation'
  AND json_extract(l.entry,'$.origin.automationId')=${automation} AND json_extract(l.entry,'$.origin.runNumber')=${number}`;
