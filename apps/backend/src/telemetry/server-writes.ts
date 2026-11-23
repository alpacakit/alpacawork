/**
 * What a CLI write counts as in usage data, decided from the same action authorization reads of it (commandAction,
 * reportIntent): the screen's op for the same write, or a CLI-only op for what the screen does not write (a state
 * report, a question, a comment, a new Task, a file), and the way its caller came. The screen's own writes count on
 * the screen.
 */
import type { MiddlewareHandler } from 'hono';
import { commandCatalog, type Command } from '@alpacawork/contract/commands';
import type { TelemetryAgent, TelemetryOp, TelemetryVia } from '@alpacawork/contract/telemetry';
import { commandAction, reportIntent, type AccessCommand, type Action, type Caller, type TaskFacts } from '../control/authorize.js';
import type { Mark } from './marks.js';

type ReportFacts = Pick<TaskFacts, 'id' | 'baseState' | 'hold' | 'openUserQuestion'>;
/** A state report by what it means for its Task, as authorization reads it. */
const REPORT_OPS: Readonly<Record<string, TelemetryOp>> = {
  unhold: 'w.unhold', confirm: 'w.approve', ask: 'w.ask', hold: 'w.hold', stop: 'w.stop',
};
/** One op per action; a report's op depends on what it means for its Task (`task`, read before the write). */
const ACTION_OPS: { readonly [Name in Action['name']]?: (action: Extract<Action, { name: Name }>, task: () => ReportFacts | null, caller: Caller) => TelemetryOp } = {
  'task.new': action => action.kind === 'project' ? 'w.project' : 'w.task',
  'task.update': () => 'w.body',
  'task.request': () => 'w.message',
  'task.answer': () => 'w.message',
  'task.report': (action, task, caller) => {
    const facts = task();
    return facts ? REPORT_OPS[reportIntent(facts, action.state, caller, !!action.confirmation).code] ?? 'w.report' : 'w.report';
  },
  'task.withdraw': () => 'w.ask',
  'task.comment': () => 'w.comment',
  'task.move': () => 'w.move',
  'task.archive': () => 'w.archive',
  'task.delete': () => 'w.delete',
  'task.restore': () => 'w.restore',
  'agent.assign': () => 'w.responsible',
  'agent.handover': () => 'w.responsible',
  'run.stop': () => 'w.runStop',
  'file.write': () => 'w.file',
};
/** The CLI writes that can count, by method and path (a path's `:name` parts match one segment). */
const COUNTED = commandCatalog.commands.filter(spec => spec.kind === 'write' && (!spec.file || spec.id === 'task/file/put'))
  .map(spec => ({ spec, path: new RegExp(`^${spec.path.replace(/:[^/]+/g, '[^/]+')}$`) }));
export function countedCommand(method: string, pathname: string): Command | undefined {
  return COUNTED.find(command => command.spec.method === method && command.path.test(pathname))?.spec;
}
/** The action a CLI command's input is, with placeholder facts: only the action's kind decides an op. */
function actionOf(command: Command, input: Record<string, unknown>): Action {
  return command.id === 'task/file/put' ? { name: 'file.write' }
    : commandAction(command.access as AccessCommand, input, { askedTo: null, worker: false, to: [] });
}
export function writeOp(command: Command, input: unknown, caller: Caller, task: (id: string) => ReportFacts): TelemetryOp | null {
  const values = input !== null && typeof input === 'object' ? input as Record<string, unknown> : {};
  const action = actionOf(command, values);
  const target = typeof values.task === 'string' ? values.task : caller.kind === 'run' ? caller.taskId : null;
  const op = ACTION_OPS[action.name] as ((action: Action, task: () => ReportFacts | null, caller: Caller) => TelemetryOp) | undefined;
  return op ? op(action, () => target === null ? null : task(target), caller) : null;
}
/** The way a CLI caller came: a person at a terminal, the coordinator in the screen's window or outside, or a Run by its agent. */
export function callerVia(caller: Caller, agentOf: (placementId: string) => TelemetryAgent): TelemetryVia {
  switch (caller.kind) {
    case 'human': return 'cli';
    case 'coordinator': return caller.source === 'screen' ? 'coord.screen' : `coord.chat.${caller.source}`;
    case 'run': return `run.${agentOf(caller.placementId)}`;
  }
}
export type CliWriteFacts = {
  caller: (request: Request) => Caller;
  /** A Task's facts as a state report reads them, before the write. */
  task: (id: string) => ReportFacts;
  agentOf: (placementId: string) => TelemetryAgent;
  /** Whether an operation was already saved: a CLI sends it again under the same ID when it did not hear the answer. */
  recorded: (opId: string) => boolean;
};
type Counter = { gate(): { state: string }; mark(fact: Mark): void; diagnostic(error: unknown): void };
/** Counts each CLI write once, when it is saved; a resend of a saved operation is not counted again. */
export function countCliWrites(telemetry: Counter, facts: CliWriteFacts): MiddlewareHandler {
  return async (c, next) => {
    const command = c.req.header('x-alpacawork-client') === 'cli' ? countedCommand(c.req.method, new URL(c.req.url).pathname) : undefined;
    const opId = c.req.header('x-alpacawork-op-id');
    if (!command || telemetry.gate().state !== 'on' || (opId !== undefined && facts.recorded(opId))) return next();
    let counted: { op: TelemetryOp; caller: Caller } | null = null;
    try {
      const json = c.req.header('content-type')?.split(';')[0]?.trim() === 'application/json';
      const input: unknown = json ? await c.req.raw.clone().json().catch(() => null) : null;
      const caller = facts.caller(c.req.raw), op = writeOp(command, input, caller, facts.task);
      if (op) counted = { op, caller };
    } catch (error) { telemetry.diagnostic(error); }
    await next();
    if (!counted || c.res.status >= 300) return;
    try { telemetry.mark({ kind: 'event', op: counted.op, attributes: { via: callerVia(counted.caller, facts.agentOf) } }); }
    catch (error) { telemetry.diagnostic(error); }
  };
}
