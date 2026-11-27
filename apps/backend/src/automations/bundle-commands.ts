import { createHash, randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { validateHeaderName, validateHeaderValue } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import type { CommandInput } from '@alpacawork/contract/commands';
import type { Caller } from '@alpacawork/contract/command-access';
import { automationTypeDeclaration, automationExamples } from '@alpacawork/contract/automation-program-assets';
import { automationProgramPreviewSchema } from '@alpacawork/contract/automation-program';
import { Problem, PROBLEM_CODE } from '@alpacawork/core';
import { touch } from '@alpacawork/db';
import { taskOrigin } from '@alpacawork/raw/task-log-schema';
import { authorize } from '../control/authorize.js';
import { readTask } from '../control/task-store.js';
import { sourceMessage } from '../coordinator/messages.js';
import type { Context, ServerCommand } from '../entries.js';
import { restoreId } from '../release/journal.js';
import { bundleEventCandidates, bundleEventChoice } from './bundle-events.js';
import {
  bundleAutomationView, bundleLimit, bundleRunRow, enqueueBundleRun, bundleRunsPage, readBundleEvent, readBundleRun,
} from './bundle-runs.js';
import { bundleNowRead, bundleNowWrite, stopBundleRun } from './bundle-runtime.js';
import {
  bundleHookChange, bundleLifecycle, bundleProject, bundleVersion, bundleVersionView, createBundleAutomation,
  editableBundleAutomation, listBundleAutomations, prepareAutomationVersion, readBundleAutomation, saveBundleAutomation,
  type BundleAutomation,
} from './bundle-store.js';
import { readHookUrl } from './hooks.js';
import { parseDestination, safeSigningKey } from './http-config.js';
import { verifyHttpDestination } from './http-transport.js';
import { receiveSignal, signalTarget } from './signals.js';

const bodyLimit = 4 * 1024 * 1024;
type AutomationCommands = Extract<import('@alpacawork/contract/commands').CommandName, `automation/${string}`>;
function caller(context: Context): Caller {
  if (!context.caller) throw new Error('Automation command must identify its caller');
  return context.caller();
}
function actor(context: Context) {
  if (!context.actor) throw new Error('Automation command must authorize its actor');
  return context.actor;
}
function runtime(context: Context) {
  if (!context.bundleRuntime) throw new Problem(PROBLEM_CODE.unavailable, 'Automation runtime is not available');
  return context.bundleRuntime;
}
function reviewed(context: Context) {
  if (!context.bundleReviews) throw new Problem(PROBLEM_CODE.unavailable, 'Automation reviews are not available');
  return context.bundleReviews;
}
const includeSource = (context: Context) => caller(context).kind === 'human';
const view = (db: DatabaseSync, root: string, a: BundleAutomation, context: Context) =>
  ({ automation: bundleAutomationView(db, root, a, new Date(), includeSource(context)) });

function messageFor(db: DatabaseSync, context: Context, request: string | undefined, expected: string) {
  const source = caller(context);
  if (source.kind !== 'coordinator' || source.source !== 'screen') {
    if (request !== undefined) throw new Problem(PROBLEM_CODE.invalidInput, 'Only the screen coordinator can use a source Request');
    return undefined;
  }
  const id = sourceMessage(db, source.runId, request);
  if (!id) return undefined;
  const record = db.prepare(`SELECT json_extract(record,'$.message.automation') AS badge FROM runs
    WHERE request_id=? AND attempt=0 AND task_id IS NULL`).get(id);
  const badge = record?.badge;
  return { id, badge: typeof badge !== 'string' ? 'no_badge' as const : badge === expected ? 'match' as const : 'mismatch' as const };
}

async function saved(root: string, input: CommandInput<'automation/new'> | CommandInput<'automation/save'>, context: Context) {
  const opId = context.opId;
  if (!opId) throw new Error('Automation save must have an operation ID');
  const by = actor(context);
  const fingerprint = createHash('sha256').update(JSON.stringify([input, by])).digest('hex');
  const request = bundleNowWrite(root, db => {
    const previous = db.prepare(`SELECT r.*,a.external_id FROM automation_save_requests r JOIN automations a
      ON a.id=r.automation_id WHERE r.op_id=?`).get(opId);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new Problem(PROBLEM_CODE.idempotencyConflict, 'Operation ID belongs to a different save');
      return { automation: readBundleAutomation(db, String(previous.external_id)), digest: String(previous.digest) };
    }
    const bundle = prepareAutomationVersion(root, input.files), at = new Date().toISOString();
    const result = 'under' in input
      ? createBundleAutomation(db, input.under, input.name, bundle, by, at, messageFor(db, context, input.sourceRequest, 'new'))
      : saveBundleAutomation(db, editableBundleAutomation(db, input.automation, input.expectedHash), bundle, by, at,
        messageFor(db, context, input.sourceRequest, input.automation));
    db.prepare('INSERT INTO automation_save_requests VALUES (?,?,?,?)').run(opId, fingerprint, result.automation.uuid, bundle.digest);
    return { ...result, digest: bundle.digest };
  });
  await reviewed(context).ensure(request.automation, request.digest);
  return bundleNowRead(root, db => {
    const automation = readBundleAutomation(db, request.automation.id), now = new Date();
    return { automation: bundleAutomationView(db, root, automation, now, includeSource(context)),
      saved: bundleVersionView(db, root, automation, request.digest, now, includeSource(context)) };
  });
}

function destinationList(db: DatabaseSync, root: string, project: string) {
  const p = bundleProject(db, project);
  const views = db.prepare(`SELECT d.name,d.host,d.version,s.version AS secret_version,s.restore_id FROM automation_destinations d
    LEFT JOIN automation_destination_secrets s USING(project_task_id,name) WHERE d.project_task_id=? ORDER BY d.name`).all(p);
  const uses = db.prepare(`SELECT DISTINCT a.external_id AS id,a.name FROM automations a
    JOIN automation_versions v ON v.automation_id=a.id AND v.digest IN (a.latest_digest,a.live_digest)
    WHERE a.project_task_id=? AND a.deleted=0 AND EXISTS(SELECT 1 FROM json_each(v.config,'$.uses.send') WHERE value=?)
    ORDER BY a.number`);
  const generation = restoreId(root);
  return { destinations: views.map(row => ({ name: String(row.name), host: String(row.host),
    ready: row.version === row.secret_version && row.restore_id === generation,
    usedBy: uses.all(p, String(row.name)).map(item => ({ id: String(item.id), name: String(item.name) })) })) };
}

function destinationUrl(db: DatabaseSync, input: CommandInput<'automation/destination-set'>, context: Context) {
  if (input.url !== undefined) return parseDestination(input.url);
  const source = caller(context);
  if (source.kind !== 'coordinator' || source.source !== 'screen') throw new Error('Destination source must be authorized');
  const id = sourceMessage(db, source.runId, input.sourceRequest!);
  const body = db.prepare('SELECT body FROM requests WHERE id=?').get(id!)?.body;
  const addresses = String(body ?? '').split(/\r?\n/).map(line => line.trim()).filter(line => /^https:\/\/\S+$/i.test(line));
  if (addresses.length !== 1 || addresses[0]!.length > 8192)
    throw new Problem(PROBLEM_CODE.invalidInput, 'Use a message with one HTTPS destination on its own line');
  return parseDestination(addresses[0]!);
}

function destinationHeader(input: string | undefined) {
  if (input === undefined) return null;
  const colon = input.indexOf(':');
  const name = input.slice(0, colon).trim(), value = input.slice(colon + 1).trim();
  try {
    if (colon < 1 || !value || /^(?:host|content-length|transfer-encoding|connection|upgrade|te|trailer|content-type|expect|proxy-.*|webhook-.*)$/i.test(name))
      throw new Error('Use an authentication header');
    validateHeaderName(name); validateHeaderValue(name, value);
  } catch {
    throw new Problem(PROBLEM_CODE.invalidInput, 'Use an authentication header such as Authorization: value');
  }
  return { name, value };
}

function automationRead(root: string, context: Context, act: 'automation.get' | 'automation.run' | 'automation.pull' | 'automation.versions',
  id: string, work: (db: DatabaseSync, a: BundleAutomation) => unknown) {
  return bundleNowRead(root, db => {
    const { readScope } = authorize(db, caller(context), { name: act }, { task: null, quote: null });
    return work(db, readBundleAutomation(db, id, readScope));
  });
}

export const bundleCommands = {
  'automation/operate': {
    act: () => ({ action: { name: 'automation.operate' }, task: null }), journaled: true,
    run: (_root, input, context) => {
      const source = caller(context);
      if (source.kind !== 'program') throw new Problem(PROBLEM_CODE.forbidden, 'This operation requires an automation credential');
      return runtime(context).operate(source, context.opId!, input.operation, input.input);
    },
  },
  'automation/types': {
    run: () => ({ declaration: automationTypeDeclaration, examples: automationExamples }),
  },
  'automation/new': {
    act: () => ({ action: { name: 'automation.new' }, task: null }), journaled: true, limit: bodyLimit, run: saved,
  },
  'automation/save': {
    act: () => ({ action: { name: 'automation.save' }, task: null }), journaled: true, limit: bodyLimit, run: saved,
  },
  'automation/get': {
    run: (root, input, context) => automationRead(root, context, 'automation.get', input.automation, (db, a) => view(db, root, a, context)),
  },
  'automation/pull': {
    run: (root, input, context) => automationRead(root, context, 'automation.pull', input.automation, (db, a) => {
      const version = bundleVersion(db, a.uuid, input.version ?? a.latest);
      return { digest: version.digest, files: version.files, declaration: automationTypeDeclaration };
    }),
  },
  'automation/versions': {
    run: (root, input, context) => automationRead(root, context, 'automation.versions', input.automation, (db, a) => ({
      versions: db.prepare('SELECT digest FROM automation_versions WHERE automation_id=? ORDER BY saved_at DESC,digest').all(a.uuid)
        .map(row => bundleVersionView(db, root, a, String(row.digest), new Date(), includeSource(context))),
    })),
  },
  'automation/list': {
    run: (root, input, context) => bundleNowRead(root, db => {
      const { readScope } = authorize(db, caller(context), { name: 'automation.list' }, { task: null, quote: null });
      const project = readScope ?? input.under ?? null;
      const fits = !readScope || !input.under || readScope === input.under;
      const automations = fits ? listBundleAutomations(db, project) : [];
      const now = new Date();
      const views = automations.map(a => bundleAutomationView(db, root, a, now));
      const day = new Intl.DateTimeFormat('en-CA').format(now);
      const today = fits ? db.prepare(`SELECT count(*) FILTER(WHERE o.name='ai.ask' AND o.call_id IS NOT NULL AND o.trial=0) AS ai,
        count(*) FILTER(WHERE o.name IN ('fetch','send') AND o.preview_id IS NULL AND o.trial=0 AND o.outcome='done') AS outside
        FROM automation_operations o JOIN tasks p ON p.id=o.project_task_id
        WHERE o.workspace_day=? AND (? IS NULL OR p.external_id=?)`).get(day, project, project) : undefined;
      return { automations: views.map(v => ({
        id: v.id, project: v.project, name: v.name, hash: v.hash, enabled: v.enabled, awaitingEnable: v.awaitingEnable,
        latest: { facts: v.latest.facts, docs: v.latest.docs }, lastRun: v.lastRun, attention: v.attention,
        week: v.week, nextAt: v.nextAt, everEnabled: v.everEnabled,
      })), counts: { enabled: views.filter(v => v.enabled).length,
        draft: views.filter(v => !v.everEnabled).length, stopped: views.filter(v => !v.enabled && v.everEnabled).length },
      today: { aiCalls: Number(today?.ai ?? 0), outside: Number(today?.outside ?? 0) } };
    }),
  },
  'automation/review': {
    act: () => ({ action: { name: 'automation.review' }, task: null }), journaled: true,
    run: async (root, input, context) => {
      const a = bundleNowRead(root, db => readBundleAutomation(db, input.automation));
      if (a.deleted) throw new Problem(PROBLEM_CODE.notFound, 'Automation was deleted');
      return { review: await reviewed(context).ensure(a, input.version, true) };
    },
  },
  'automation/runs': {
    run: (root, input, context) => bundleNowRead(root, db => {
      const { readScope } = authorize(db, caller(context), { name: 'automation.runs' }, { task: null, quote: null });
      const automation = input.automation === undefined ? undefined : readBundleAutomation(db, input.automation, readScope);
      return bundleRunsPage(db, { automation, scope: readScope, limit: input.limit ?? 50, before: input.before, cursor: input.cursor });
    }),
  },
  'automation/run': {
    run: (root, input, context) => automationRead(root, context, 'automation.run', input.automation, (db, a) =>
      ({ run: readBundleRun(db, a, input.number), event: readBundleEvent(db, { uuid: a.uuid, number: input.number }) })),
  },
  'automation/preview': {
    act: () => ({ action: { name: 'automation.preview' }, task: null }), journaled: true, limit: bodyLimit,
    run: async (root, input, context) => {
      const prepared = input.files && prepareAutomationVersion(root, input.files);
      const { automation, project, version, event, events } = bundleNowRead(root, db => {
        const { readScope } = authorize(db, caller(context), { name: 'automation.preview' }, { task: null, quote: null });
        const automation = input.automation ? readBundleAutomation(db, input.automation, readScope) : null;
        const project = automation?.project ?? input.under!;
        if (readScope !== null && readScope !== project || automation?.deleted) throw new Problem(PROBLEM_CODE.notFound, 'Automation project does not exist');
        bundleProject(db, project);
        const version = prepared || bundleVersion(db, automation!.uuid, automation!.latest);
        const now = new Date();
        const events = bundleEventCandidates(db, root, version.config, project, automation, now);
        const event = input.event === undefined && input.syntheticEvent === undefined && version.config.on.event === 'schedule' && events.length
          ? events[0]! : bundleEventChoice(db, root, version.config, project, automation, input, now);
        return { automation, project, version, event, events };
      });
      return { events, preview: event ? await runtime(context).preview(project, automation, version, event, actor(context), !!input.run) : null };
    },
  },
  'automation/try': {
    act: () => ({ action: { name: 'automation.try' }, task: null }), limit: bodyLimit,
    run: (root, input) => bundleNowWrite(root, db => {
      const automation = readBundleAutomation(db, input.automation), now = new Date();
      if (automation.deleted) throw new Problem(PROBLEM_CODE.notFound, 'Automation was deleted');
      const version = bundleVersion(db, automation.uuid, automation.latest);
      const selected = db.prepare(`SELECT event,result FROM automation_previews WHERE automation_id=? AND digest=? AND at>=?
        AND json_extract(result,'$.hash')=?`).get(automation.uuid, version.digest, new Date(now.getTime() - 7 * 86_400_000).toISOString(), input.previewHash);
      if (!selected) throw new Problem(PROBLEM_CODE.conflict, 'Preview changed; run the preview again');
      const preview = automationProgramPreviewSchema.parse(JSON.parse(String(selected.result)));
      if (preview.outcome.state !== 'done' || preview.trigger?.run === false) throw new Problem(PROBLEM_CODE.conflict, 'Choose an event that passed its preview');
      const stored = JSON.parse(String(selected.event));
      const event = input.event === undefined && input.syntheticEvent === undefined ? stored
        : bundleEventChoice(db, root, version.config, automation.project, automation, input, now);
      if (!event || !isDeepStrictEqual(event, stored)) throw new Problem(PROBLEM_CODE.conflict, 'Event changed; run the preview again');
      if (db.prepare("SELECT 1 FROM automation_runs WHERE automation_id=? AND mode='trial' AND state='running'").get(automation.uuid))
        throw new Problem(PROBLEM_CODE.conflict, 'An automation trial is already running');
      return { automation: { id: automation.id, project: automation.project },
        run: enqueueBundleRun(db, automation, version.digest, event, 'trial', now) };
    }),
  },
  'automation/run-now': {
    act: () => ({ action: { name: 'automation.run-now' }, task: null }), limit: bodyLimit,
    run: (root, input) => bundleNowWrite(root, db => {
      const automation = readBundleAutomation(db, input.automation), now = new Date();
      if (!automation.live || automation.deleted) throw new Problem(PROBLEM_CODE.conflict, 'Enable the automation before running it');
      const version = bundleVersion(db, automation.uuid, automation.live);
      const event = bundleEventChoice(db, root, version.config, automation.project, automation, input, now);
      if (!event) throw new Problem(PROBLEM_CODE.invalidInput, 'Choose an event or supply an event file');
      return { automation: { id: automation.id, project: automation.project },
        run: enqueueBundleRun(db, automation, version.digest, event, 'live', now, bundleLimit(db, automation, version.config, now)) };
    }),
  },
  'automation/run-stop': {
    act: () => ({ action: { name: 'automation.run-stop' }, task: null }),
    run: (root, input) => bundleNowWrite(root, db => {
      const automation = readBundleAutomation(db, input.automation);
      const run = stopBundleRun(db, automation, input.number, input.expectedRunVersion, new Date())
        ?? readBundleRun(db, automation, input.number);
      return { automation: { id: automation.id, project: automation.project }, run };
    }),
  },
  'automation/enable': {
    act: () => ({ action: { name: 'automation.enable' }, task: null }),
    run: (root, input, context) => bundleNowWrite(root, db => view(db, root, bundleLifecycle(db, root,
      editableBundleAutomation(db, input.automation, input.expectedHash), { kind: 'enabled', acknowledge: !!input.acknowledgeReview }, actor(context), new Date()), context)),
  },
  'automation/disable': {
    act: input => ({ action: { name: 'automation.disable', automation: input.automation }, task: null }),
    run: (root, input, context) => bundleNowWrite(root, db => view(db, root, bundleLifecycle(db, root,
      readBundleAutomation(db, input.automation), { kind: 'disabled' }, actor(context), new Date()), context)),
  },
  'automation/restore': {
    act: () => ({ action: { name: 'automation.restore' }, task: null }),
    run: (root, input, context) => bundleNowWrite(root, db => view(db, root, bundleLifecycle(db, root,
      editableBundleAutomation(db, input.automation, input.expectedHash), { kind: 'restored', digest: input.version }, actor(context), new Date()), context)),
  },
  'automation/rename': {
    act: () => ({ action: { name: 'automation.rename' }, task: null }),
    run: (root, input, context) => bundleNowWrite(root, db => view(db, root, bundleLifecycle(db, root,
      editableBundleAutomation(db, input.automation, input.expectedHash), { kind: 'renamed', name: input.name }, actor(context), new Date()), context)),
  },
  'automation/delete': {
    act: () => ({ action: { name: 'automation.delete' }, task: null }),
    run: (root, input, context) => bundleNowWrite(root, db => view(db, root, bundleLifecycle(db, root,
      editableBundleAutomation(db, input.automation, input.expectedHash), { kind: 'deleted' }, actor(context), new Date()), context)),
  },
  'automation/hook-read': {
    run: (root, input, context) => bundleNowRead(root, db => {
      authorize(db, caller(context), { name: 'automation.hook-read' }, { task: null, quote: null });
      if (!context.hookOrigin) throw new Error('HTTP hook requires an origin');
      return { url: readHookUrl(db, input.automation, context.hookOrigin, restoreId(root)) };
    }),
  },
  'automation/hook-create': hook('create'),
  'automation/hook-rotate': hook('rotate'),
  'automation/hook-delete': hook('delete'),
  'automation/destination-set': {
    act: input => ({ action: { name: input.sourceRequest !== undefined ? 'automation.destination-set.from_request' : 'automation.destination-set' }, task: null }),
    prepareWrite: async (root, input, context) => {
      const url = bundleNowRead(root, db => destinationUrl(db, input, context));
      const header = destinationHeader(input.header);
      const signingKey = safeSigningKey(input.signingKey);
      const failure = await (context.verifyAutomationHttp ?? verifyHttpDestination)(url);
      if (failure) throw new Problem(PROBLEM_CODE.invalidInput, 'Could not verify the HTTPS destination', undefined, { reason: { kind: failure } });
      return { bundleDestination: { url, signingKey, header } };
    },
    run: (root, input, context) => bundleNowWrite(root, db => {
      const destination = context.bundleDestination;
      if (!destination) throw new Error('Verify the destination first');
      const project = bundleProject(db, input.under);
      const version = Number(db.prepare(`INSERT INTO automation_destinations(project_task_id,name,host,version) VALUES (?,?,?,1)
        ON CONFLICT(project_task_id,name) DO UPDATE SET host=excluded.host,version=version+1 RETURNING version`)
        .get(project, input.name, destination.url.hostname)!.version);
      db.prepare(`INSERT INTO automation_destination_secrets(project_task_id,name,version,restore_id,url,header,signing_key)
        VALUES (?,?,?,?,?,?,?) ON CONFLICT(project_task_id,name) DO UPDATE SET version=excluded.version,restore_id=excluded.restore_id,
        url=excluded.url,header=excluded.header,signing_key=excluded.signing_key`)
        .run(project, input.name, version, restoreId(root), destination.url.href, destination.header ? JSON.stringify(destination.header) : null, destination.signingKey);
      for (const a of listBundleAutomations(db, input.under)) touch(db, { kind: 'automation', id: a.id });
      return destinationList(db, root, input.under);
    }),
  },
  'automation/destination-list': {
    run: (root, input, context) => bundleNowRead(root, db => {
      const { readScope } = authorize(db, caller(context), { name: 'automation.destination-list' }, { task: input.under, quote: null });
      if (readScope && readScope !== input.under) throw new Problem(PROBLEM_CODE.notFound, 'Project does not exist');
      return destinationList(db, root, input.under);
    }),
  },
  'automation/signal': {
    automationIngress: ({ automation }) => automation,
    act: (input, context) => ({ action: { name: 'automation.signal' }, task: signalTarget(context.db, input.automation, context.caller) }),
    run: (root, input, context) => bundleNowWrite(root, db => receiveSignal(db, input, caller(context), context.opId!, new Date())),
    limit: bodyLimit,
  },
  'automation/input': {
    run: (root, input, context) => bundleNowRead(root, db => {
      const { readScope } = authorize(db, caller(context), { name: 'automation.input' }, { task: input.task, quote: null });
      const origin = taskOrigin(readTask(db, input.task, 'none').meta.log);
      if (!origin) throw new Problem(PROBLEM_CODE.notFound, 'This task has no automation input');
      const a = readBundleAutomation(db, origin.automationId, readScope);
      const row = db.prepare('SELECT data FROM automation_task_inputs WHERE task_id=?').get(input.task);
      return { automation: a.id, run: origin.runNumber, data: row ? JSON.parse(String(row.data)) : null };
    }),
  },
} satisfies { [N in AutomationCommands]: ServerCommand<CommandInput<N>> };

function hook(operation: 'create' | 'rotate' | 'delete'): ServerCommand<CommandInput<'automation/hook-create'>> {
  return {
    act: () => ({ action: { name: `automation.hook-${operation}` }, task: null }),
    run: (root, input, context) => bundleNowWrite(root, db => view(db, root, bundleHookChange(db,
      editableBundleAutomation(db, input.automation, input.expectedHash), operation, randomBytes(32).toString('base64url'),
      actor(context), new Date().toISOString()), context)),
  };
}
