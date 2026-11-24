/** Access is a view of real authorization decisions, never a second permission table. */
import { Problem } from '@alpacawork/core';
import { commandAction, decide, actsOf, SEAT_TEXT, CONDITION_TEXT, type AccessCommand, type Action,
  type Caller, type CommandFacts, type TaskFacts, type Act } from './command-access.js';
import { operationReadActions, operationReadHelp, replyAccess, reportCallerRules, urgentRecipient, localCaller } from './access-boundaries.js';
import { localStopCaller } from './local-stop.js';

type Example = { label: string; action: Action; task?: Partial<TaskFacts>; asked?: boolean;
  /** The Task is the project above the Run callers' own (P0, above T1). */ above?: boolean };
const example = (command: AccessCommand, label: string, input: Record<string, unknown> = {},
  facts: CommandFacts = {}, task?: Partial<TaskFacts>): Example =>
  ({ label, action: commandAction(command, input, facts), task, asked: facts.askedTo !== undefined && facts.askedTo !== null });
const read: Example[] = [{ label: 'Read', action: { name: 'task.read' } }];
/** A read a Run may also make of the projects above its own: their policies reach its launches. */
const readUp: Example[] = [...read, { label: 'Read a project above the Run\'s own (Task here means that project)',
  action: { name: 'task.read' }, task: { id: 'P0', kind: 'project', parentId: null, project: 'P0' }, above: true }];
const file: Example[] = [{ label: 'Write files', action: { name: 'file.write' } }];
const held = { state: 'held', hold: true } as const;
const review = { state: 'waiting', baseState: 'waiting', userRequested: true } as const;
const failure = { state: 'error', baseState: 'error', userRequested: true } as const;

/** Only example inputs and their labels live here. commandAction and decide supply all permission facts. */
const accessExamples: Readonly<Record<string, readonly Example[]>> = {
  deploy: [{label:'Local deployment (Run acts on its own Task)',action:{name:'release'}}],
  'project.shelf': [{ label: 'Project catalog', action: { name: 'screen' } }],
  'task.get': readUp, 'task.returns': readUp, 'run.get': readUp, 'field.get': readUp,
  'field.list': [{ label: 'Read field definitions', action: { name: 'field.list' } }],
  'field.set': [{ label: 'Add or change a field definition', action: { name: 'field.set' } }],
  'field.delete': [{ label: 'Delete a field definition', action: { name: 'field.delete' } }],
  'field.use': [{ label: 'Project fields (Task here means the project)', action: { name: 'field.use' },
    task: { kind: 'project', id: 'T1', parentId: null, project: 'T1' } }],
  'task.file-get': readUp,
  'task.list': [{ label: 'Read tree', action: { name: 'task.list' } }],
  'task.file-put': file, 'task.attachment-put': file, 'task.attachment-remove': file, 'task.attachment-move': file,
  'task.new': [
    example('task.new', '--no-from-user (Task here means --parent)', { fromUser: false }),
    example('task.new', '--no-from-user --parent <project>', { fromUser: false }, {}, { kind: 'project', id: 'P1', parentId: null, project: 'P1' }),
    example('task.new', '--from-user --parent <project>', { fromUser: true }, {}, { kind: 'project', id: 'P1', parentId: null, project: 'P1' }),
    example('task.new', '--kind project', { kind: 'project' }),
  ],
  'task.update': [
    example('task.update', '--title / --values-file', { title: 'Title', values: {} }),
    example('task.update', '--cwd / --color / --from-user / --no-from-user', { cwd: '', color: '#39659b', fromUser: false }),
  ],
  'task.report': [
    example('task.report', '--withdraw <id> (question\'s Task)', { withdraw: 'Q1' }),
    example('task.report', '--state doing', { state: 'doing' }),
    example('task.report', '--state doing (own Run: progress; manager: return held Task)', { state: 'doing' }, {}, held),
    example('task.report', '--state waiting (Run: question; outside Run: submit review)', { state: 'waiting' }),
    example('task.report', '--state done (owner report)', { state: 'done' }),
    example('task.report', '--state done (target awaiting review)', { state: 'done' }, {}, review),
    example('task.report', '--state done (target with an open question to the user)', { state: 'done' }, {},
      { baseState: 'doing', openUserQuestion: true }),
    example('task.report', '--about-run (confirm review)', { state: 'done', aboutRun: 'R1' }, {}, review),
    example('task.report', '--values-file (--state doing/waiting/done)', { state: 'doing', values: {} }),
    example('task.report', '--state held', { state: 'held' }),
    example('task.report', '--state todo/error (return held Task)', { state: 'todo' }, {}, { ...held, baseState: 'todo' }),
    example('task.report', '--state waiting (own Run: question; manager: return held review)', { state: 'waiting' }, {}, { ...held, baseState: 'waiting', userRequested: true }),
    example('task.report', '--state done/stopped (return held terminal Task)', { state: 'done' }, {}, { ...held, baseState: 'done' }),
    example('task.report', '--state stopped', { state: 'stopped' }),
    example('task.report', '--state stopped (review or failed user-requested Task)', { state: 'stopped' }, {}, failure),
  ],
  'task.request': [
    example('task.request', 'Instruction to responsible', {}),
    example('task.request', '--agent <member>', { agent: 'P4' }, { worker: true }),
    example('task.request', 'Instruction to failed user-requested Task', {}, {}, failure),
    example('task.request', '--answers (question addressed to user)', { answers: 'Q1' }, { askedTo: null, closed: false }),
    example('task.request', '--answers (question addressed to Task)', { answers: 'Q1' }, { askedTo: 'T5', closed: false }),
    example('task.request', '--answers (closed; failed user-requested Task; addressed to user)', { answers: 'Q1' }, { askedTo: null, closed: true }, failure),
    example('task.request', '--answers (closed; failed user-requested Task; addressed to Task)', { answers: 'Q1' }, { askedTo: 'T5', closed: true }, failure),
  ],
  'dependency.set': [example('task.request', 'Ordinary instruction to responsible')],
  'dependency.clear': [example('task.request', 'Ordinary instruction to responsible')],
  'task.comment': [example('task.comment', 'Comment'), example('task.comment', '--urgent', { urgent: 'Reason' })],
  'task.move': [
    example('task.move', 'Within parent responsible\'s subtree', { parent: 'T6' }, { to: ['T6', 'T2', 'T1'] }),
    example('task.move', 'Outside that subtree', { parent: 'T7' }, { to: ['T7', 'T1'] }),
  ],
  ...Object.fromEntries((['archive', 'delete', 'restore'] as const).map(name =>
    [`task.${name}`, [example(`task.${name}`, 'Manage Task')]])),
  'agent.assign': [example('agent.assign', '--role responsible', { role: 'responsible' }),
    example('agent.assign', '--role member', { role: 'member' })],
  'agent.handover': [example('agent.handover', 'Transfer responsibility')],
  'agent.release': [example('agent.release', 'Responsible placement', {}, { worker: false }),
    example('agent.release', 'Member placement', {}, { worker: true })],
  'run.stop': [example('run.stop', 'Target Run\'s Task')],
  'agent.compact': [example('agent.compact', 'The responsible\'s conversation', { agent: 'P3' }, { worker: false }),
    example('agent.compact', 'A member\'s conversation, by another Run', { agent: 'P9m' }, { worker: true })],
  'config.inspect': [{ label: 'Inspect executables', action: { name: 'config.inspect' } }],
  'config.set': [{ label: 'Change configuration', action: { name: 'config.set' } }],
  'settings.get': [{ label: 'Read the person\'s settings', action: { name: 'settings.read' } }],
  'settings.set': [{ label: 'Save one of the person\'s settings', action: { name: 'settings.set' } }],
  'workspace.returns': [{ label: 'Retry returns', action: { name: 'admin' } }],
  'workspace.init': [{ label: 'Local administration', action: { name: 'admin' } }],
  'workspace.serve': [{ label: 'Local administration', action: { name: 'admin' } }],
  'workspace.maintenance': [{ label: 'Local administration', action: { name: 'admin' } }],
  ...Object.fromEntries(['build', 'pack', 'rollback', 'recover', 'operation', 'prune', 'status'].map(name =>
    [`release.${name}`, [{ label: 'Local release (Run acts on its own Task)', action: { name: 'release' } }]])),
};
const run = (taskId: string, worker = false): Caller => ({ kind: 'run', taskId,
  runId: `R${taskId.slice(1)}`, placementId: `P${taskId.slice(1)}${worker ? 'm' : ''}`, role: worker ? 'worker' : 'owner', responsible: !worker });
const callers = {
  human: { kind: 'human' }, coordinator: { kind: 'coordinator', source: 'claude', conversation: 'S1' },
  own: run('T3'), parent: run('T2'), member: run('T3', true), other: run('T4'), asked: run('T5'), foreign: run('T20'),
} satisfies Record<string, Caller>;
type Person = keyof typeof callers;
const taskFor = (item: Example): TaskFacts => ({ id: 'T3', parentId: 'T2', project: 'T1', kind: 'task',
  state: 'doing', baseState: 'doing', hold: false, userRequested: false, ...item.task });
function permits(item: Example, person: Person, ownHeld: boolean): boolean {
  const caller = callers[person], task = taskFor(item);
  const result = decide(caller, item.action, { task: item.action.name === 'task.list' ? null : task,
    quote: null, runProject: caller.kind === 'run' ? (person === 'foreign' ? 'T10' : 'T1') : null,
    runProjectsAbove: caller.kind === 'run' && person !== 'foreign' ? ['P0'] : [],
    runState: caller.kind !== 'run' ? null : ownHeld || (caller.taskId === task.id && task.hold) ? 'held' : 'doing' });
  return !(result instanceof Problem);
}
function peopleText(people: readonly Person[], item: Example): string {
  const remaining = new Set(people), text: string[] = [];
  if (remaining.has('human') && remaining.has('coordinator')) {
    text.push(SEAT_TEXT.user); remaining.delete('human'); remaining.delete('coordinator');
  }
  if (remaining.has('human')) { text.push(SEAT_TEXT.human); remaining.delete('human'); }
  if (remaining.has('coordinator')) { text.push('the coordinator'); remaining.delete('coordinator'); }
  const runs: Person[] = ['own', 'parent', 'member', 'other', ...(item.asked ? ['asked' as const] : [])];
  if (runs.every(person => remaining.has(person))) {
    text.push(remaining.has('foreign') ? SEAT_TEXT.run
      : `${SEAT_TEXT.run} ${item.above ? CONDITION_TEXT.project_above : CONDITION_TEXT.same_project}`);
    remaining.delete('foreign');
    for (const person of runs) remaining.delete(person);
  } else if (['own', 'parent', 'other'].every(person => remaining.has(person as Person)) && !remaining.has('member')) {
    text.push(`${SEAT_TEXT.responsible} ${CONDITION_TEXT.same_project}`);
    for (const person of ['own', 'parent', 'other'] as const) remaining.delete(person);
  } else if (remaining.has('own') && remaining.has('member')) {
    text.push(SEAT_TEXT.placement); remaining.delete('own'); remaining.delete('member');
  }
  const labels: Record<Person, string> = { human: SEAT_TEXT.human, coordinator: 'the coordinator', own: SEAT_TEXT.own,
    parent: SEAT_TEXT.parent, member: 'a member Run of this Task', other: 'another Run in this project',
    foreign: 'a Run in another project', asked: SEAT_TEXT.own.replace('the Task', 'the addressed Task') };
  for (const person of remaining) text.push(labels[person]);
  return text.join('; or ') || 'none';
}
function permissionText(item: Example): string {
  const people = (Object.keys(callers) as Person[]).filter(person => person !== 'asked' || item.asked);
  const normal = people.filter(person => permits(item, person, false));
  const text = peopleText(normal, item);
  const runs = normal.filter(person => callers[person].kind === 'run');
  if (!runs.length) return text;
  const allowedHeld = runs.filter(person => permits(item, person, true));
  return text + (allowedHeld.length === runs.length ? ' [own Task held: allowed]' :
    !allowedHeld.length ? ' [own Task held: unavailable]' : ` [own Task held: ${peopleText(allowedHeld, item)}]`);
}
const unrestricted = new Set(['config.get', 'workspace.url', 'help', 'guide']);
const clientOnly = new Set(['server.show', 'server.set', 'server.unset']);
export const accessHelpPointer = 'Before executing, read Access in <group> <command> -h (roles, targets and options).';
export function accessHelp(command: string): string {
  if (clientOnly.has(command)) return '\nAccess: local client settings; outside server authorization. Changing the server grants no server permissions.';
  if (command === 'open') return '\nAccess: local; starts a browser on this PC and grants no server permissions.';
  if (unrestricted.has(command)) return '\nAccess: no role restriction at this entry; caller identification still applies.';
  if (command === 'run.stop-local') return `\nAccess: ${localStopCaller.help}`;
  if (command === 'coordinator reply.get') return `\nAccess: ${replyAccess.help}`;
  if (command === 'operation.get') return `\nAccess: ${operationReadHelp}\n  Referenced Tasks: only ${permissionText({ label: 'Referenced Tasks', action: operationReadActions(['T3'])[0]!.action })}.\n  No Task: only ${permissionText({ label: 'No Task', action: operationReadActions([])[0]!.action })}.`;
  const examples = accessExamples[command];
  if (!examples) throw new Error(`No access description for ${command}`);
  const groups = new Map<string, string[]>();
  for (const item of examples) {
    const permission = permissionText(item);
    groups.set(permission, [...(groups.get(permission) ?? []), item.label]);
  }
  const lines = [...groups].map(([permission, labels]) => `  ${labels.join(' / ')}: ${permission === 'none' ? 'no caller' : 'only ' + permission}.`);
  if (command === 'task.report') lines.push(
    '  Withdrawal: ask that responsible through task request; check task request -h for instruction access.',
    `  ${reportCallerRules.checkpoint.help}`, `  ${reportCallerRules.askTo.help}`, `  ${urgentRecipient.help}`);
  if (command === 'task.comment') {
    const index = lines.findIndex(line => line.includes('--urgent:'));
    if (index >= 0) lines[index] += ' ' + urgentRecipient.help.replace('--urgent: ', '');
  }
  if (command === 'task.update') lines.push('  Every changed field must be allowed.');
  if (command === 'task.list') lines.push('  A Run\'s tree is restricted to its own project.');
  if (command === 'deploy' || command.startsWith('release.') || ['workspace.init', 'workspace.serve', 'workspace.maintenance'].includes(command))
    lines.push('  ' + localCaller.help);
  return `\nAccess (server authorization; user approval and state rules still apply):\n${lines.join('\n')}`;
}

/** Exhaustiveness evidence: every real act is explained by a CLI example, or explicitly has no CLI. */
const nonCliActs: readonly Act[] = ['screen', 'coordinator.screen', 'runtime', 'update.review', 'update.confirm', 'update.cancel'];
export function describedActs(): Act[] {
  const result = new Set<Act>(nonCliActs);
  for (const examples of Object.values(accessExamples)) for (const item of examples)
    for (const caller of Object.values(callers)) for (const act of actsOf(item.action, taskFor(item), caller)) result.add(act);
  // operation get also uses screen for receipts naming no Task; the reply read has its own entry constraint.
  return [...result];
}
