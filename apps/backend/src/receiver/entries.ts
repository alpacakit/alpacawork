import { mcpCommandHelp, mcpSkill } from './mcp-help.js';
import { codecs, defineEntry, defineEntryEndpoint, defineEntryNode, defineEntryTree, defineParameter, optional, required, } from '@alpacakit/channels';
import { bindHttpEntry } from '@alpacakit/channels/http';
import { bindCliOptions } from '@alpacawork/cli-kit';
import { commandTree, type Command, type CommandInput } from '@alpacawork/contract/commands';
import { hostEpisodeInput } from '@alpacawork/contract';
import { DEFAULT_SERVER_PORT } from '@alpacawork/contract/default-server';
import { PUBLIC_HOST_PATTERN, agentLimitsReadInput, emptyInput, personNoticesSaveInput, personSettingsSetInput, presencePauseInput, presenceReportInput, pushSubscribeInput, pushUnsubscribeInput, serveInput, taskFinishedInput, taskSearchInput, taskShelvedInput, taskTimelineAxisInput, taskTimelineInput } from '@alpacawork/contract/inputs';
import { PROBLEM_CODE, Problem, parseInput } from '@alpacawork/core';
import { z } from 'zod';
import { readProjectShelf } from '../control/project-shelf.js';
import { SCREEN, authorizeRead, foldersNode, initNode, requireAdmin, requireCaller, requireRoot, taskCommands, withAct, withRequestLimit,
  type JsonCommandName, type ServerCommand, type Context as TaskContext } from '../entries.js';
import { type HostMonitor } from '../host/monitor.js';
import type { AgentLimitsMonitor } from '../agents/limits.js';
import { maintenance } from '../maintenance.js';
import type { PublishedFrame } from './projection-contract.js';
import { ProjectedPages } from './index-pages.js';
const pageReads = new ProjectedPages();
import { createFirstRunState, createNoticeState, createPersonSettings } from './person-state.js';
import { firstRunNodes } from './first-run-entries.js';
import type { FirstRunSkills } from '../installation/first-run-skills.js';
import { type Presence } from './presence.js';
import { type PushStore } from './push.js';
import { history, query, requireReadFrame, view } from './task-read-entries.js';
import { updateNode } from './update-entries.js';
import { workspaceUrl } from './workspace-url.js';

import type { AnalysisReader } from '../analysis/reads.js';
import { activeAnalysisWork } from '../analysis/active-work.js';
import { readAt, readFindings, readTrace } from '../analysis/timeline-reads.js';

export interface Context extends TaskContext {
  analysis?: AnalysisReader;
  push?: PushStore;
  presence?: Presence;
  host?: HostMonitor;
  limits?: AgentLimitsMonitor;
  presenceChanged?: () => void;
  presenceSettings?: () => ReturnType<ReturnType<typeof createPersonSettings>['values']>;
  /** The screen's index: every active project's Tasks. */
  readFrame?: () => PublishedFrame | Promise<PublishedFrame>;
  personSettings?: ReturnType<typeof createPersonSettings>;
  noticeState?: ReturnType<typeof createNoticeState>;
  firstRun?: ReturnType<typeof createFirstRunState>;
  skills?: FirstRunSkills;
  /** The index Owner already serialized this representation; the HTTP adapter sends its bytes directly. */
  readLive?: () => Promise<Response>;
  personChanged?: (kind: 'settings' | 'notices', revision: string | null) => void;
}
/** `host[:port]` as browsers send it: lower-case, no scheme, no path. */
export { PUBLIC_HOST_PATTERN };


const serveEntry = defineEntry({
  name: 'serve',
  parameters: [
    defineParameter({
      name: 'port',
      description: `Loopback port (default ${DEFAULT_SERVER_PORT}); 0 selects an available port`,
      // channels' numeric shape only supports positive integers; the input schema
      // accepts zero and checks the port after the CLI has read its text.
      codec: codecs.string(),
      requirement: optional({ default: String(DEFAULT_SERVER_PORT) }),
    }),
    defineParameter({
      name: 'public-host',
      description: 'Host[:port] the tailnet reaches this service by (behind tailscale serve), for example host.example:8443',
      codec: codecs.string(),
      requirement: optional(),
    }),
    defineParameter({ name: 'mcp', description: 'Enable the MCP endpoint', codec: codecs.boolean(), requirement: optional() }),
    defineParameter({ name: 'timing', description: 'Log the duration of each reconciliation step to stderr as JSON lines',
      codec: codecs.boolean(), requirement: optional() }),
  ],
  project: ({ values }) => values,
});
export type ServeOptions = { publicHost?: string; timing?: boolean; mcp?: boolean };
export const serve = defineEntryEndpoint(serveEntry, {
  handler: (input: ReturnType<typeof serveEntry.project>, context: Context) => {
    const values = parseInput(serveInput, input);
    if (!context.serve) throw new Problem(PROBLEM_CODE.forbidden, 'serve is only available from the local CLI', undefined, { reason: { kind: 'serve_only_available_from_local_cli' } });
    const root = requireRoot(context, 'existing');
    requireAdmin(context, () => root);
    return context.serve(root, values.port, { publicHost: values['public-host'], timing: values.timing === true, mcp: values.mcp === true });
  },
  channels: [bindCliOptions(serveEntry.parameters)],
});

function requirePush(context: Context): PushStore {
  if (!context.push) throw new Problem(PROBLEM_CODE.unavailable, 'Push notifications are not running', undefined, { reason: { kind: 'push_notifications_not_running' } });
  return context.push;
}
const pushKey = withAct(defineEntryEndpoint(defineEntry({ name: 'key', parameters: [], project: () => ({}) }), {
  handler: (input: unknown, context: Context) => {
    parseInput(emptyInput, input);
    return { key: requirePush(context).publicKey };
  },
  channels: [bindHttpEntry({ method: 'GET' })],
}), SCREEN);
const pushDevices = withAct(defineEntryEndpoint(defineEntry({ name: 'devices', parameters: [], project: () => ({}) }), {
  handler: (input: unknown, context: Context) => {
    parseInput(emptyInput, input);
    return { devices: requirePush(context).devices() };
  },
  channels: [bindHttpEntry({ method: 'GET' })],
}), SCREEN);
const subscribeEntry = defineEntry({
  name: 'subscribe',
  parameters: [
    defineParameter({
      name: 'subscription', description: 'PushSubscription.toJSON() of this browser', requirement: required(),
      codec: codecs.define({ schema: z.json(), shape: { kind: 'string' } }),
    }),
    defineParameter({ name: 'label', description: 'Device name shown in the list', requirement: required(), codec: codecs.string() }),
  ],
  project: ({ values }) => values,
});
const pushSubscribe = withAct(defineEntryEndpoint(subscribeEntry, {
  handler: (input: ReturnType<typeof subscribeEntry.project>, context: Context) => {
    const values = parseInput(pushSubscribeInput, input);
    return requirePush(context).subscribe(values.subscription, values.label);
  },
  channels: [bindHttpEntry({ method: 'POST' })],
}), SCREEN);
const unsubscribeEntry = defineEntry({
  name: 'unsubscribe',
  parameters: [defineParameter({ name: 'id', description: 'Device ID from the list', requirement: required(), codec: codecs.string() })],
  project: ({ values }) => values,
});
const pushUnsubscribe = withAct(defineEntryEndpoint(unsubscribeEntry, {
  handler: (input: ReturnType<typeof unsubscribeEntry.project>, context: Context) => {
    const values = parseInput(pushUnsubscribeInput, input);
    return requirePush(context).unsubscribe(values.id);
  },
  channels: [bindHttpEntry({ method: 'POST' })],
}), SCREEN);
// A page or a search names a project Task as its `scope` to read that project's subtree, nested projects included;
// naming none, it reads every project.
const searchEntry = defineEntry({ name: 'search', parameters: [query('text', 'Search text'),
  defineParameter({ name: 'scope', description: 'Project Task whose subtree to search', requirement: optional(), codec: codecs.string() }),
  defineParameter({ name: 'after', description: 'Continue after this Task', requirement: optional(), codec: codecs.string() }),
  defineParameter({ name: 'limit', description: 'Page size', requirement: optional(), codec: codecs.string() })], project: ({ values }) => values });
const search = withAct(defineEntryEndpoint(searchEntry, {
  handler: (input: ReturnType<typeof searchEntry.project>, context: Context) => {
    const values = parseInput(taskSearchInput, input);
    return requireReadFrame(context).then(frame => pageReads.search(frame, values.text, values.scope ?? null, values.after, values.limit));
  },
  channels: [bindHttpEntry({ method: 'GET' })],
}), SCREEN);
const finishedEntry = defineEntry({ name: 'finished', parameters: [query('parent', 'Parent Task or root'),
  defineParameter({ name: 'scope', description: 'Project Task whose top level to read', requirement: optional(), codec: codecs.string() }),
  defineParameter({ name: 'after', description: 'Page cursor', requirement: optional(), codec: codecs.string() }),
  defineParameter({ name: 'limit', description: 'Page size up to 20', requirement: optional(), codec: codecs.string() })],
  project: ({ values }) => values });
const finished = withAct(defineEntryEndpoint(finishedEntry, {
  handler: (input: ReturnType<typeof finishedEntry.project>, context: Context) => {
    const values = parseInput(taskFinishedInput, input);
    return requireReadFrame(context).then(frame => pageReads.finished(frame, values.parent === 'root' ? null : values.parent, values.scope ?? null,
      values.after, values.limit));
  }, channels: [bindHttpEntry({ method: 'GET' })],
}), SCREEN);
const shelvedEntry = defineEntry({ name: 'shelved', parameters: [
  defineParameter({ name: 'scope', description: 'Project Task whose subtree to read', requirement: optional(), codec: codecs.string() }),
  defineParameter({ name: 'after', description: 'Page cursor', requirement: optional(), codec: codecs.string() }),
  defineParameter({ name: 'limit', description: 'Page size up to 20', requirement: optional(), codec: codecs.string() })],
  project: ({ values }) => values });
const shelved = withAct(defineEntryEndpoint(shelvedEntry, {
  handler: (input: ReturnType<typeof shelvedEntry.project>, context: Context) => {
    const values = parseInput(taskShelvedInput, input);
    return requireReadFrame(context).then(frame => pageReads.shelved(frame, values.scope ?? null, values.after, values.limit));
  }, channels: [bindHttpEntry({ method: 'GET' })],
}), SCREEN);
const timelineAxisEntry = defineEntry({ name: 'timeline-axis', parameters: [
  query('lanes', 'Row Task IDs'),
], project: ({ values }) => values });
const timelineAxis = withAct(defineEntryEndpoint(timelineAxisEntry, {
  handler: (input: ReturnType<typeof timelineAxisEntry.project>, context: Context) =>
    requireReadFrame(context).then(frame => pageReads.timelineAxis(frame, parseInput(taskTimelineAxisInput, input))),
  channels: [bindHttpEntry({ method: 'GET' })],
}), SCREEN);
const timelineEntry = defineEntry({ name: 'timeline', parameters: [
  query('lanes', 'Row Task IDs'), query('from', 'Visible range start'), query('to', 'Visible range end'),
  defineParameter({ name: 'limit', description: 'Events per answer up to 2000', requirement: optional(), codec: codecs.string() }),
], project: ({ values }) => values });
const timeline = withAct(defineEntryEndpoint(timelineEntry, {
  handler: (input: ReturnType<typeof timelineEntry.project>, context: Context) =>
    requireReadFrame(context).then(frame => pageReads.timeline(frame, parseInput(taskTimelineInput, input))),
  channels: [bindHttpEntry({ method: 'GET' })],
}), SCREEN);
const empty = (name: string) => defineEntry({ name, parameters: [], project: () => ({}) });
const live = withAct(defineEntryEndpoint(empty('live'), {
  handler: async (input: unknown, context: Context) => {
    parseInput(emptyInput, input);
    if (!context.readLive) throw new Problem(PROBLEM_CODE.unavailable, 'Index is not running', undefined, { reason: { kind: 'index_not_running' } });
    return context.readLive();
  }, channels: [bindHttpEntry({ method: 'GET' })],
}), SCREEN);
const presenceReportEntry = defineEntry({ name: 'presence', parameters: [
  defineParameter({ name: 'screen', description: 'Page instance ID', requirement: required(), codec: codecs.string() }),
  ...(['seq', 'touchSeq', 'touchedAgo', 'hiddenAgo'] as const).map(name => defineParameter({ name,
    description: name === 'seq' || name === 'touchSeq' ? 'Page-local sequence' : 'Event age in milliseconds, or null',
    requirement: required(), codec: codecs.define({ schema: presenceReportInput.shape[name], shape: { kind: 'string' } }) })),
], project: ({ values }) => values });
const activePresence = withAct(defineEntryEndpoint(presenceReportEntry, {
  handler: (input: unknown, context: Context) => {
    context.presence!.report(parseInput(presenceReportInput, input));
    context.presenceChanged?.();
    return context.presence!.status(context.presenceSettings!());
  }, channels: [bindHttpEntry({ method: 'POST' })],
}), SCREEN);
const awayPresence = withAct(defineEntryEndpoint(empty('away'), {
  handler: (input: unknown, context: Context) => {
    parseInput(emptyInput, input);
    context.presence!.away();
    context.presenceChanged?.();
    return context.presence!.status(context.presenceSettings!());
  }, channels: [bindHttpEntry({ method: 'POST' })],
}), SCREEN);
const pausePresenceEntry = defineEntry({ name: 'pause', parameters: [
  defineParameter({ name: 'duration', description: 'Pause duration', requirement: required(), codec: codecs.string() }),
  defineParameter({ name: 'timeZone', description: 'Browser time zone', requirement: required(), codec: codecs.string() }),
], project: ({ values }) => values });
const pausePresence = withAct(defineEntryEndpoint(pausePresenceEntry, {
  handler: async (input: ReturnType<typeof pausePresenceEntry.project>, context: Context) => {
    const valid = parseInput(presencePauseInput, input);
    const result = await context.personSettings!.pause(valid.duration, valid.timeZone);
    context.personChanged?.('settings', result.revision);
    return context.presence!.status(result.values);
  }, channels: [bindHttpEntry({ method: 'POST' })],
}), SCREEN);
const resumePresence = withAct(defineEntryEndpoint(empty('resume'), {
  handler: async (input: unknown, context: Context) => {
    parseInput(emptyInput, input);
    const result = await context.personSettings!.resume();
    context.personChanged?.('settings', result.revision);
    return context.presence!.status(result.values);
  }, channels: [bindHttpEntry({ method: 'POST' })],
}), SCREEN);
/**
 * The person's settings: the one read and the one save the screen and the command line (settings get, settings set)
 * both use. A save from either reaches the screen as a changed revision (personChanged).
 */
const notices = withAct(defineEntryEndpoint(empty('notices'), {
  handler: async (input: unknown, context: Context) => {
    parseInput(emptyInput, input);
    const result = await context.noticeState!.get();
    context.personChanged?.('notices', result.revision);
    if (result.state) return result;
    const frame = await requireReadFrame(context);
    return { ...result, initialBaselines: Object.fromEntries([...frame.records.taskIds()].flatMap(id => {
      const row = frame.derived(id)?.row;
      return row ? [[id, { log: row.notice.logCount, state: row.state, body: row.notice.bodyHash, turnKey: row.notice.turnKey }]] : [];
    })) };
  },
  channels: [bindHttpEntry({ method: 'GET' })],
}), SCREEN);
const noticesSaveEntry = defineEntry({ name: 'save', parameters: [
  defineParameter({ name: 'state', description: 'Notice checkpoint and reads', requirement: required(), codec: codecs.define({ schema: z.json(), shape: { kind: 'string' } }) }),
  defineParameter({ name: 'expectedRevision', description: 'Current notice revision', requirement: required(), codec: codecs.define({ schema: z.json(), shape: { kind: 'string' } }) }),
], project: ({ values }) => values });
const noticesSave = withAct(withRequestLimit(defineEntryEndpoint(noticesSaveEntry, {
  handler: async (input: ReturnType<typeof noticesSaveEntry.project>, context: Context) => {
    const valid = parseInput(personNoticesSaveInput, input);
    const result = await context.noticeState!.save(valid.state, valid.expectedRevision);
    context.personChanged?.('notices', result.revision);
    return result;
  }, channels: [bindHttpEntry({ method: 'POST' })],
}), 1024 * 1024), SCREEN);

function requireHost(context: Context): HostMonitor {
  if (!context.host) throw new Problem(PROBLEM_CODE.unavailable, 'Host status is not running', undefined, { reason: { kind: 'host_status_not_running' } });
  return context.host;
}
const hostStatus = withAct(defineEntryEndpoint(empty('status'), {
  handler: (input: unknown, context: Context) => {
    parseInput(emptyInput, input);
    return requireHost(context).status();
  }, channels: [bindHttpEntry({ method: 'GET' })],
}), SCREEN);
/** Each kind of agent's plan limits, in the screen's order. */
const agentLimitsEntry = defineEntry({ name: 'limits', parameters: [
  defineParameter({ name: 'fresh', description: 'Ask every agent again now (no model is called)', codec: codecs.boolean(), requirement: optional() }),
], project: ({ values }) => values });
const agentLimits = withAct(defineEntryEndpoint(agentLimitsEntry, {
  handler: (input: ReturnType<typeof agentLimitsEntry.project>, context: Context) =>
    context.limits!.read({ fresh: parseInput(agentLimitsReadInput, input).fresh === true }),
  channels: [bindHttpEntry({ method: 'GET' })],
}), SCREEN);
const hostEpisodeEntry = defineEntry({ name: 'episode', parameters: [
  defineParameter({ name: 'id', description: 'Episode ID', requirement: required(), codec: codecs.string() }),
], project: ({ values }) => values });
const hostEpisode = withAct(defineEntryEndpoint(hostEpisodeEntry, {
  handler: (input: ReturnType<typeof hostEpisodeEntry.project>, context: Context) => {
    const { id } = parseInput(hostEpisodeInput, input);
    const minutes = requireHost(context).episodeMinutes(id);
    if (!minutes) throw new Problem(PROBLEM_CODE.notFound, `Host episode ${id} is not recorded`, undefined, { reason: { kind: 'host_episode_not_recorded', id: String(id) } });
    return minutes;
  }, channels: [bindHttpEntry({ method: 'GET' })],
}), SCREEN);

const sharedNodes = [updateNode, ...firstRunNodes,
  defineEntryNode({ name: 'host', description: 'This machine (Resources)', children: [
    defineEntryNode({ name: 'status', description: 'Current values, the last hour and tight episodes', endpoints: [hostStatus] }),
    defineEntryNode({ name: 'episode', description: 'Minute values around one tight episode', endpoints: [hostEpisode] }),
  ] }),
  defineEntryNode({ name: 'limits', description: "Agents' plan usage limits", endpoints: [agentLimits] }),
  defineEntryNode({ name: 'presence', description: 'Current screen activity', endpoints: [activePresence], children: [
    defineEntryNode({ name: 'away', description: 'Set away for at least one minute', endpoints: [awayPresence] }),
    defineEntryNode({ name: 'pause', description: 'Pause notifications', endpoints: [pausePresence] }),
    defineEntryNode({ name: 'resume', description: 'Resume notifications', endpoints: [resumePresence] }),
  ] }),
  defineEntryNode({ name: 'task', description: 'Task records and instructions', children: [
    defineEntryNode({ name: 'view', description: 'Opened Task', endpoints: [view] }),
    defineEntryNode({ name: 'history', description: 'Task chronology', endpoints: [history] }),
    defineEntryNode({ name: 'search', description: 'Find Tasks', endpoints: [search] }),
    defineEntryNode({ name: 'finished', description: 'Finished direct children', endpoints: [finished] }),
    defineEntryNode({ name: 'shelved', description: 'Archived and deleted Tasks', endpoints: [shelved] }),
    defineEntryNode({ name: 'timeline-axis', description: 'Rows\' full-lifetime time axis activity', endpoints: [timelineAxis] }),
    defineEntryNode({ name: 'timeline', description: 'Rows\' time strips over a range', endpoints: [timeline] }),
  ] }),
  defineEntryNode({ name: 'person', description: 'Personal state', children: [
    defineEntryNode({ name: 'notices', description: 'Read checkpoints', endpoints: [notices], children: [
      defineEntryNode({ name: 'save', description: 'Save read checkpoints', endpoints: [noticesSave] }),
    ] }),
  ] }),
  defineEntryNode({ name: 'workspace', description: 'Workspace operations', children: [
    foldersNode,
    defineEntryNode({ name: 'serve', description: 'Serve the local task UI and API', endpoints: [serve] }),
    defineEntryNode({ name: 'live', description: 'Current live projection', endpoints: [live] }),
  ] }),
  defineEntryNode({ name: 'notify', description: 'Notifications and devices', children: [
    defineEntryNode({ name: 'key', description: 'VAPID key', endpoints: [pushKey] }),
    defineEntryNode({ name: 'devices', description: 'Subscribed devices', endpoints: [pushDevices] }),
    defineEntryNode({ name: 'subscribe', description: 'Register a device', endpoints: [pushSubscribe] }),
    defineEntryNode({ name: 'unsubscribe', description: 'Remove a device', endpoints: [pushUnsubscribe] }),
  ] }),
] as const;

const maintenanceEntry = defineEntry({ name: 'maintenance', parameters: [
  defineParameter({ name: 'mode', description: 'inspect, migrate or compact', codec: codecs.string(), requirement: required() }),
], project: ({ values }) => values });
/** The backend executable is only for local, stopped-server administration. */
export const adminNodes = [defineEntryNode({ name: 'workspace', description: 'Local server administration',
  children: [initNode,
    defineEntryNode({ name: 'serve', description: 'Serve the local task UI and API', endpoints: [serve] }),
    defineEntryNode({ name: 'maintenance', description: 'Inspect, migrate or compact with serve stopped', endpoints: [defineEntryEndpoint(
      maintenanceEntry,
      { handler: (input: { mode?: string }, context: Context) => { const root = requireRoot(context);
        requireAdmin(context, () => root);
        return maintenance(root, z.enum(['inspect','migrate','compact']).parse(input.mode)); },
        channels: [bindCliOptions(maintenanceEntry.parameters)] })] }),
  ] })];

export const screenTree = defineEntryTree(
  defineEntryNode({
    name: 'alpacawork',
    description: 'RAW tasks',
    children: sharedNodes,
  }),
);

const implementations = {
  'help': { run: (_root, input) => mcpCommandHelp(input.commands) },
  'guide': { run: (_root, input) => mcpSkill(input.name) },
  ...taskCommands,
  'analysis/tasks': { run: (_root, input, context) => context.analysis!.tasks(input, requireCaller(context),
    async (allows, slices) => activeAnalysisWork(await requireReadFrame(context), allows, slices)) },
  'analysis/usage': { run: (_root, input, context) => context.analysis!.usage(input, requireCaller(context)) },
  'analysis/usage-series': { run: (_root, input, context) => context.analysis!.usageSeries(input, requireCaller(context)) },
  'analysis/breakdown': { run: (_root, input, context) => context.analysis!.breakdown(input, requireCaller(context)) },
  'analysis/list': { run: (_root, input, context) => context.analysis!.list(input, requireCaller(context)) },
  'analysis/task': { run: (_root, input, context) => context.analysis!.task(input, requireCaller(context)) },
  'analysis/trace': {
    run: async (root, input, context) => {
      authorizeRead(root, context, { name: 'task.read' }, input.task);
      return readTrace(root, input, await context.analysis!.activity(requireCaller(context)));
    },
  },
  'analysis/changes': { run: (_root, input, context) => context.analysis!.changes(input, requireCaller(context)) },
  'analysis/findings': { run: (root, input, context) => { authorizeRead(root, context, { name: 'task.read' }, input.task); return readFindings(root, input); } },
  'analysis/at': { run: (root, input, context) => { authorizeRead(root, context, { name: 'task.read' }, input.task); return readAt(root, input); } },
  'project/shelf': {
    run: (root, _input, context) => {
      authorizeRead(root, context, SCREEN, null);
      return readProjectShelf(root).catalog();
    },
  },
  'workspace/url': {
    run: root => workspaceUrl(root),
  },
  'settings/get': {
    run: (root, _input, context) => {
      authorizeRead(root, context, { name: 'settings.read' }, null);
      return context.personSettings!.get();
    },
  },
  'settings/set': {
    act: () => ({ action: { name: 'settings.set' }, task: null }),
    run: async (_root, input, context) => {
      const values = parseInput(personSettingsSetInput, input);
      const result = await context.personSettings!.set(values.key, values.value, values.expectedRevision, values.timeZone);
      context.personChanged?.('settings', result.revision);
      return result;
    },
  },
  'operation/get': {
    run: (_root, input, context) => context.readOperation!(input.opId, requireCaller(context)),
  },
} satisfies { [Name in JsonCommandName]: ServerCommand<CommandInput<Name>, Context> };

// Entry projection validates the input associated with this key before the erased route adapter calls it.
const commands = implementations as unknown as Record<JsonCommandName, ServerCommand<Record<string, unknown>, Context>>;
export const serverCommandTree = commandTree<Context>((command, verify) => {
  if (command.file) return () => { throw new Error('File routes are installed by the byte transport'); };
  const implementation = commands[command.id as JsonCommandName];
  if (command.kind !== 'read' && !implementation.act) throw new Error(`Missing write action for ${command.id}`);
  return async (input, context) => {
    const result = verify(await implementation.run(requireRoot(context), input, context));
    if (command.kind === 'write') context.changed?.();
    return result;
  };
});

export const serverCommands = new Map<string, Command & { implementation: ServerCommand<Record<string, unknown>, Context> }>(serverCommandTree.commands.flatMap(command =>
  command.file ? [] : [[`${command.method} ${command.path}`, {
    ...command, implementation: commands[command.id as JsonCommandName],
  }] as const]));
