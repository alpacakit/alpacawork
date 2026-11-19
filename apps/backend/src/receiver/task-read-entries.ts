import { codecs, defineEntry, defineEntryEndpoint, defineParameter, optional, required } from '@alpacakit/channels';
import { bindHttpEntry } from '@alpacakit/channels/http';
import { taskViewInput } from '@alpacawork/contract/inputs';
import { PROBLEM_CODE, Problem, parseInput } from '@alpacawork/core';
import { SCREEN, withAct, type Context as TaskContext } from '../entries.js';
import type { PublishedFrame } from './projection-contract.js';
import { ProjectedHistory, projectedView } from './task-reads.js';
import { historyWindowInput } from './task-read-inputs.js';

/** The server captures the arrival floor and supplies the published frame after it reaches that floor. */
export type ProjectedReadContext = { readFrame?: () => PublishedFrame | Promise<PublishedFrame> };
type Context = TaskContext & ProjectedReadContext;
export async function requireReadFrame(context: ProjectedReadContext): Promise<PublishedFrame> {
  if (!context.readFrame) throw new Problem(PROBLEM_CODE.unavailable, 'Projection is not running', undefined,
    { reason: { kind: 'index_not_running' } });
  return context.readFrame();
}
const historyReads = new ProjectedHistory();

export const query = <Name extends string>(name: Name, description: string) => defineParameter({
  name, description, requirement: required(), codec: codecs.string(),
});

function requireListedTask(frame: PublishedFrame, id: string): void {
  const task = frame.records.bundle(id)?.task;
  if (!task) throw new Problem(PROBLEM_CODE.notFound, 'Task does not exist', { task: id }, { reason: { kind: 'task_does_not_exist' } });
  const projectId = frame.records.projectOf(id), shelf = frame.records.shelf().of(projectId);
  if (!shelf.listed) throw new Problem(PROBLEM_CODE.notFound, 'Task belongs to an archived project',
    { task: { id, title: task.meta.title, kind: task.meta.kind, lifecycle: task.meta.lifecycle, projectId }, shelf },
    { reason: { kind: 'task_archived' } });
}

const viewEntry = defineEntry({ name: 'view', parameters: [
  defineParameter({ name: 'task', description: 'Task ID', requirement: optional(), codec: codecs.string() }),
  defineParameter({ name: 'address', description: 'Task path or ID', requirement: optional(), codec: codecs.string() }),
], project: ({ values }) => values });

export const view = withAct(defineEntryEndpoint(viewEntry, {
  handler: (input: ReturnType<typeof viewEntry.project>, context: Context) => {
    const values = parseInput(taskViewInput, input);
    const address = 'address' in values ? values.address : values.task;
    return requireReadFrame(context).then(frame => {
      const id = address.slice(address.lastIndexOf('/') + 1), task = frame.records.bundle(id)?.task;
      if (!task || address !== id && address !== task.path)
        throw new Problem(PROBLEM_CODE.notFound, 'Task does not exist', { task: address }, { reason: { kind: 'task_does_not_exist' } });
      requireListedTask(frame, id);
      return projectedView(frame, id);
    });
  },
  channels: [bindHttpEntry({ method: 'GET' })],
}), SCREEN);

const historyEntry = defineEntry({ name: 'history', parameters: [query('task', 'Task ID'), query('mode', 'History window: latest, since, protect or older'),
  defineParameter({ name: 'before', description: 'Older than this cursor', requirement: optional(), codec: codecs.string() }),
  defineParameter({ name: 'since', description: 'Refresh from this oldest held key', requirement: optional(), codec: codecs.string() }),
  defineParameter({ name: 'keep', description: 'Keep at most this many newest events', requirement: optional(), codec: codecs.string() }),
  defineParameter({ name: 'protect', description: 'Preserve this key through the newest event', requirement: optional(), codec: codecs.string() }),
  defineParameter({ name: 'limit', description: 'Older events, at most 80', requirement: optional(), codec: codecs.string() })],
  project: ({ values }) => values });

export const history = withAct(defineEntryEndpoint(historyEntry, {
  handler: (input: ReturnType<typeof historyEntry.project>, context: Context) => {
    const values = parseInput(historyWindowInput, input);
    return requireReadFrame(context).then(frame => {
      requireListedTask(frame, values.task);
      return historyReads.read(frame, values.task, values.window);
    });
  }, channels: [bindHttpEntry({ method: 'GET' })],
}), SCREEN);
