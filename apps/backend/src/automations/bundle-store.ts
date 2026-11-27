import type { AutomationMessageChange } from '@alpacawork/contract/automation';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import {
  AUTOMATION_SDK_CONTRACT_VERSION, automationBundleSchema, automationConfigSchema, automationEvents,
  automationProgramDocsSchema, automationProgramPreviewSchema, automationReviewResultSchema,
  type AutomationBundle, type AutomationConfig, type AutomationVersion,
} from '@alpacawork/contract/automation-program';
import type { Issue } from '@alpacawork/core/issues';
import { Problem, PROBLEM_CODE, redactSecrets } from '@alpacawork/core';
import { touch } from '@alpacawork/db';
import type { TaskActor } from '@alpacawork/raw';
import { launchSnapshot, readAgentsSettings } from '../agents-settings.js';
import { restoreId } from '../release/journal.js';
import { analyzeAutomationBundle } from './bundle-source.js';
import { checkAutomationTimezone } from './schedule.js';
import { bundleScheduleTimes } from './bundle-events.js';
import { bundleEventReader, startingBundlePosition } from './bundle-readers.js';
import { requestBundleStop } from './bundle-runs.js';

export type BundleReviewer = TaskActor | { kind: 'system' };
type Row = Record<string, SQLOutputValue>;
export type BundleChange = 'created' | 'saved' | 'enabled' | 'disabled' | 'restored' | 'deleted' | 'renamed' |
  'hook_created' | 'hook_rotated' | 'hook_deleted';
export type BundleAutomation = {
  uuid: string;
  id: string;
  projectUuid: string;
  project: string;
  name: string;
  revision: number;
  hash: string;
  latest: string;
  live: string | null;
  enabled: boolean;
  deleted: boolean;
  activationRevision: number | null;
  activationEpoch: number | null;
  disabledReason: string | null;
  nextAt: string | null;
  eventAfter: number | null;
  hostPressureAfter: string | null;
  hostPressureCursor: { episodeStart: number; entryThrough: number | null; observedAt: number } | null;
};

export const automationBundleDigest = (files: AutomationBundle, version = AUTOMATION_SDK_CONTRACT_VERSION) =>
  createHash('sha256').update(JSON.stringify([version, files])).digest('hex');

export function frozenBundleAi(root: string, selection: { agent: string; model: string; effort: string }) {
  const settings = readAgentsSettings(root);
  if (settings.ok === false) throw settings.error;
  const { agent, model, effort } = selection;
  const snap = launchSnapshot(settings.config, agent, 'start', process.env.PATH ?? '', { model, effort });
  if (!snap.ok || !isDeepStrictEqual({ model, effort }, {
    model: snap.launch.values.model, effort: snap.launch.values.effort,
  })) throw new Error('Choose an available agent, model and effort');
  return snap.launch;
}

export function prepareAutomationVersion(root: string, input: AutomationBundle, now = new Date()) {
  const files = [...input].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  let checked: (AutomationConfig & { timezone: string }) | undefined;
  const { docs, parts, aiUses } = analyzeAutomationBundle(files, (config, configPath, configLine) => {
    const decoded = automationConfigSchema.safeParse(config);
    const issues: Issue[] = [];
    const issue = (keys: readonly PropertyKey[], message: string) => issues.push({
      path: `${configPath}:config${keys.length ? '.' + keys.map(String).join('.') : ''}`,
      code: 'invalid_value', message, params: { line: configLine(keys) },
    });
    if (!decoded.success) {
      for (const error of decoded.error.issues) issue(error.path, error.message);
      return issues;
    }
    const value = decoded.data;
    const timezone = value.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    try { checkAutomationTimezone(timezone); }
    catch (error) { issue(['timezone'], (error as Error).message); }
    if (automationEvents[value.on.event].candidates === 'next' && !issues.length) {
      try {
        if (!bundleScheduleTimes({ ...value, timezone }, now).length)
          throw new Error('The schedule has no upcoming occurrence');
      } catch (error) { issue(['on', 'where', 'cron'], (error as Error).message); }
    }
    for (const [name, selection] of Object.entries(value.uses?.ai ?? {})) {
      try { frozenBundleAi(root, selection); }
      catch (error) { issue(['uses', 'ai', name], (error as Error).message); }
    }
    if (!issues.length) checked = { ...value, timezone };
    return issues;
  });
  if (!checked) throw new Error('The automation analyzer omitted config validation');
  return { files, digest: automationBundleDigest(files), contractVersion: AUTOMATION_SDK_CONTRACT_VERSION,
    config: checked, docs: automationProgramDocsSchema.parse(docs), parts, aiUses };
}

export type PreparedAutomationVersion = ReturnType<typeof prepareAutomationVersion>;
type SavedVersion = PreparedAutomationVersion & { savedAt: string; savedBy: BundleReviewer; review: AutomationVersion['review'] };

function decodeAutomation(row: Row): BundleAutomation {
  const id = String(row.external_id), revision = Number(row.revision);
  return {
    uuid: String(row.id), id, projectUuid: String(row.project_task_id), project: String(row.project), name: String(row.name), revision,
    hash: createHash('sha256').update(JSON.stringify([row.id, revision])).digest('hex'),
    latest: String(row.latest_digest), live: row.live_digest as string | null, enabled: Boolean(row.enabled),
    deleted: Boolean(row.deleted), activationRevision: row.activation_revision as number | null, disabledReason: row.disabled_reason as string | null,
    activationEpoch: row.activation_epoch as number | null,
    nextAt: row.next_at as string | null, eventAfter: row.event_after as number | null, hostPressureAfter: row.host_pressure_after as string | null,
    hostPressureCursor: row.host_pressure_cursor === null ? null : JSON.parse(String(row.host_pressure_cursor)),
  };
}

const automationRows = 'SELECT a.*,p.external_id AS project FROM automations a JOIN tasks p ON p.id=a.project_task_id';
export function readBundleAutomation(db: DatabaseSync, id: string, scope: string | null = null): BundleAutomation {
  const row = db.prepare(automationRows + ' WHERE a.external_id=? AND (? IS NULL OR p.external_id=?)').get(id, scope, scope);
  if (!row) throw new Problem(PROBLEM_CODE.notFound, 'Automation does not exist');
  return decodeAutomation(row);
}

export function listBundleAutomations(db: DatabaseSync, project: string | null): BundleAutomation[] {
  return db.prepare(automationRows + ' WHERE a.deleted=0 AND (? IS NULL OR p.external_id=?) ORDER BY a.number')
    .all(project, project).map(decodeAutomation);
}

export function bundleProject(db: DatabaseSync, project: string): string {
  const row = db.prepare("SELECT id FROM tasks WHERE external_id=? AND kind='project' AND lifecycle='active'").get(project);
  if (!row) throw new Problem(PROBLEM_CODE.notFound, 'Project does not exist');
  return String(row.id);
}

function assertEditable(automation: BundleAutomation, expectedHash: string): void {
  if (automation.deleted) throw new Problem(PROBLEM_CODE.notFound, 'Automation was deleted');
  if (expectedHash !== automation.hash) throw new Problem(PROBLEM_CODE.conflict, 'Automation changed; read it again', { hash: automation.hash });
}

export function editableBundleAutomation(db: DatabaseSync, id: string, hash: string): BundleAutomation {
  const automation = readBundleAutomation(db, id);
  assertEditable(automation, hash);
  return automation;
}

function insertVersion(db: DatabaseSync, uuid: string, bundle: PreparedAutomationVersion, now: string, actor: BundleReviewer): boolean {
  const review: AutomationVersion['review'] = { state: 'running', findings: [], summary: '', model: null, at: now, acknowledged: null };
  return !!db.prepare(`INSERT INTO automation_versions(automation_id,digest,contract_version,saved_at,saved_by,files,config,docs,parts,ai_uses,review)
    VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(automation_id,digest) DO NOTHING`)
    .run(uuid, bundle.digest, bundle.contractVersion, now, JSON.stringify(actor), JSON.stringify(bundle.files), JSON.stringify(bundle.config),
      JSON.stringify(bundle.docs), JSON.stringify(bundle.parts), JSON.stringify(bundle.aiUses), JSON.stringify(review)).changes;
}

export function bundleVersion(db: DatabaseSync, uuid: string, digest: string): SavedVersion {
  const row = db.prepare('SELECT * FROM automation_versions WHERE automation_id=? AND digest=?').get(uuid, digest);
  if (!row) throw new Problem(PROBLEM_CODE.notFound, 'Automation version does not exist');
  return { digest, contractVersion: Number(row.contract_version), savedAt: String(row.saved_at), savedBy: JSON.parse(String(row.saved_by)),
    files: automationBundleSchema.parse(JSON.parse(String(row.files))),
    config: JSON.parse(String(row.config)) as AutomationConfig & { timezone: string },
    docs: automationProgramDocsSchema.parse(JSON.parse(String(row.docs))), parts: JSON.parse(String(row.parts)), aiUses: JSON.parse(String(row.ai_uses)),
    review: automationReviewResultSchema.parse(JSON.parse(String(row.review))) };
}

function recordChange(db: DatabaseSync, automation: BundleAutomation, kind: BundleChange, actor: BundleReviewer, at: string,
  message?: { id: string; badge: 'match' | 'mismatch' | 'no_badge' }, acknowledgement?: unknown) {
  const actors = { main: 'coordinator', placement: 'coordinator', human: 'human', automation: 'automation', system: 'system' } as const;
  db.prepare(`INSERT INTO automation_changes(automation_id,revision,previous_revision,kind,actor,digest,acknowledgement,message_id,badge_match,at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(automation.uuid, automation.revision, kind === 'created' ? null : automation.revision - 1, kind,
      actors[actor.kind], automation.latest, acknowledgement === undefined ? null : JSON.stringify(acknowledgement), message?.id ?? null, message?.badge ?? null, at);
  touch(db, { kind: 'automation', id: automation.id });
}

export function createBundleAutomation(db: DatabaseSync, project: string, name: string, bundle: PreparedAutomationVersion,
  actor: BundleReviewer, at: string, message?: Parameters<typeof recordChange>[5]) {
  const uuid = randomUUID(), projectUuid = bundleProject(db, project);
  const row = db.prepare(`INSERT INTO automations(id,number,project_task_id,name,latest_digest,revision)
    VALUES (?, (SELECT coalesce(max(number),0)+1 FROM automations),?,?,?,1) RETURNING external_id`)
    .get(uuid, projectUuid, name, bundle.digest)!;
  insertVersion(db, uuid, bundle, at, actor);
  const automation = readBundleAutomation(db, String(row.external_id));
  db.prepare('UPDATE automation_previews SET automation_id=? WHERE project_task_id=? AND automation_id IS NULL AND digest=?')
    .run(uuid, projectUuid, bundle.digest);
  recordChange(db, automation, 'created', actor, at, message);
  return { automation, inserted: true };
}

export function saveBundleAutomation(db: DatabaseSync, automation: BundleAutomation, bundle: PreparedAutomationVersion,
  actor: BundleReviewer, at: string, message?: Parameters<typeof recordChange>[5]) {
  const inserted = insertVersion(db, automation.uuid, bundle, at, actor);
  if (bundle.digest === automation.latest) return { automation, inserted };
  db.prepare('UPDATE automations SET latest_digest=?,revision=revision+1 WHERE id=?').run(bundle.digest, automation.uuid);
  const saved = readBundleAutomation(db, automation.id);
  recordChange(db, saved, 'saved', actor, at, message);
  return { automation: saved, inserted };
}

export function updateBundleReview(db: DatabaseSync, automation: BundleAutomation, digest: string, review: AutomationVersion['review']) {
  db.prepare('UPDATE automation_versions SET review=? WHERE automation_id=? AND digest=?').run(JSON.stringify(review), automation.uuid, digest);
  touch(db, { kind: 'automation', id: automation.id });
}

const effectParts: Readonly<Record<string, AutomationVersion['outsideEffects'][number]['kind']>> = {
  fs: 'file', http: 'network', https: 'network', http2: 'network', net: 'network', tls: 'network',
  dgram: 'network', dns: 'network', child_process: 'process', cluster: 'process', worker_threads: 'process',
  module: 'other', vm: 'other', process: 'process',
};

function outsideEffects(version: SavedVersion): AutomationVersion['outsideEffects'] {
  const effects: AutomationVersion['outsideEffects'] = [];
  for (const part of version.parts) {
    const module = part.slice('node:'.length).split('/')[0]!;
    if (Object.hasOwn(effectParts, module)) effects.push({ kind: effectParts[module]!, text: part });
  }
  for (const finding of version.review.findings) {
    if (finding.outsideEffect) effects.push({ kind: finding.outsideEffect, text: finding.text });
  }
  return effects;
}

/** The first save owns provenance even when the same content is restored or saved again. */
function versionSourceRequest(db: DatabaseSync, automation: string, digest: string): AutomationVersion['sourceRequest'] {
  const result = db.prepare(`SELECT q.id,q.body AS text
    FROM automation_changes c LEFT JOIN requests q ON q.id=c.message_id
    WHERE c.automation_id=? AND c.digest=? AND c.kind IN ('created','saved') ORDER BY c.revision LIMIT 1`)
    .get(automation, digest);
  if (typeof result?.id !== 'string' || typeof result.text !== 'string' || !result.text.trim()) return null;
  const text = redactSecrets(result.text).replace(/https?:\/\/[^\s<>"']+/gi, value => {
    try { return new URL(value).origin; } catch { return '[redacted]'; }
  });
  return { id: result.id, text };
}

export function bundleVersionView(db: DatabaseSync, root: string, automation: BundleAutomation, digest: string, now: Date, includeSource = false): AutomationVersion {
  const saved = bundleVersion(db, automation.uuid, digest), { config } = saved;
  const project = automation.projectUuid;
  const latestPreview = db.prepare(`SELECT result FROM automation_previews WHERE project_task_id=? AND
    (automation_id=? OR automation_id IS NULL) AND digest=? AND result IS NOT NULL ORDER BY at DESC,id LIMIT 1`).get(project, automation.uuid, digest);
  const recent = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const cost = db.prepare(`SELECT sum(cost_usd)/count(DISTINCT call_id) AS mean
    FROM automation_operations WHERE name='ai.ask' AND at>=? AND cost_usd IS NOT NULL AND project_task_id=?
    AND json_extract(target,'$.name')=? AND json_extract(target,'$.agent')=? AND json_extract(target,'$.model')=? AND json_extract(target,'$.effort')=?`);
  const destination = db.prepare(`SELECT d.host,s.restore_id,s.version AS secret_version,d.version FROM automation_destinations d
    LEFT JOIN automation_destination_secrets s USING(project_task_id,name) WHERE d.project_task_id=? AND d.name=?`);
  const generation = restoreId(root);
  return {
    digest, contractVersion: saved.contractVersion, savedAt: saved.savedAt, savedBy: saved.savedBy,
    files: saved.files.map(({ path, source }) => ({ path, bytes: Buffer.byteLength(source) })), docs: saved.docs, parts: saved.parts,
    outsideEffects: outsideEffects(saved), sourceRequest: includeSource ? versionSourceRequest(db, automation.uuid, digest) : null,
    facts: {
      when: { event: config.on.event, where: config.on.where ?? null, textKey: automationEvents[config.on.event].textKey,
        filter: saved.docs.trigger?.summary ?? null },
      limits: { perDay: config.limits.perDay, cooldownMinutes: config.limits.cooldownMinutes ?? 0, waitForPrevious: config.limits.waitForPrevious ?? true,
        until: config.limits.until ?? null, timeoutMinutes: config.limits.timeoutMinutes ?? 10,
        aiCallsPerDay: config.limits.aiCallsPerDay ?? 20, tasksPerRun: config.limits.tasksPerRun ?? 0, timezone: config.timezone },
      ai: Object.entries(config.uses?.ai ?? {}).map(([name, row]) => {
        const { mean } = cost.get(recent, project, name, row.agent, row.model, row.effort)!;
        const uses = Object.hasOwn(saved.aiUses, name) ? saved.aiUses[name]! : null;
        return { name, ...row, uses, costHint: typeof mean === 'number' ? { perCallUsd: mean } : null };
      }),
      outside: (config.uses?.send ?? []).map(name => {
        const row = destination.get(project, name);
        return { name, host: row ? String(row.host) : null, ready: row?.restore_id === generation && row.secret_version === row.version };
      }),
    },
    review: saved.review, preview: latestPreview ? automationProgramPreviewSchema.parse(JSON.parse(String(latestPreview.result))) : null,
  };
}

export function bundleLifecycle(db: DatabaseSync, root: string, automation: BundleAutomation, command:
  { kind: 'enabled'; acknowledge: boolean } | { kind: 'disabled'; reason?: string } | { kind: 'deleted' }
  | { kind: 'restored'; digest: string } | { kind: 'renamed'; name: string }, actor: BundleReviewer, now: Date): BundleAutomation {
  const at = now.toISOString(), values = { latest: automation.latest, live: automation.live, activation: automation.activationRevision, epoch: automation.activationEpoch,
    name: automation.name, deleted: automation.deleted, disabled: automation.disabledReason, next: automation.nextAt,
    after: automation.eventAfter, hostAfter: automation.hostPressureAfter, hostCursor: automation.hostPressureCursor };
  let acknowledgement: unknown;
  const swapping = command.kind === 'enabled' && automation.live !== null && automation.live !== automation.latest;
  switch (command.kind) {
    case 'enabled': {
      const version = bundleVersion(db, automation.uuid, automation.latest);
      if (version.contractVersion !== AUTOMATION_SDK_CONTRACT_VERSION) throw new Problem(PROBLEM_CODE.conflict, 'Save with the current SDK');
      if (version.config.limits.until && automationLocalDay(version.config.timezone, now) > version.config.limits.until)
        throw new Problem(PROBLEM_CODE.conflict, 'The automation has expired');
      for (const selection of Object.values(version.config.uses?.ai ?? {})) frozenBundleAi(root, selection);
      if (bundleVersionView(db, root, automation, automation.latest, now).facts.outside.some(row => !row.ready))
        throw new Problem(PROBLEM_CODE.conflict, 'Enter every declared destination before enabling');
      if (version.review.state === 'running' || (version.review.state !== 'ok' && !command.acknowledge))
        throw new Problem(PROBLEM_CODE.conflict, 'Acknowledge the review before enabling');
      if (version.review.state !== 'ok') {
        acknowledgement = { by: actor, at, reviewAt: version.review.at };
        updateBundleReview(db, automation, automation.latest, { ...version.review, acknowledged: { by: actor, at } });
      }
      if (automation.latest === automation.live) return automation;
      values.live = automation.latest;
      values.activation = automation.revision + 1;
      values.epoch = automation.activationEpoch ?? values.activation;
      values.disabled = null;
      Object.assign(values, startingBundlePosition(bundleEventReader(version.config.on), db, version.config, now));
      break;
    }
    case 'deleted': values.deleted = true;
    // Both operations revoke all ongoing work.
    case 'disabled':
      values.live = null; values.activation = null; values.epoch = null; values.next = null; values.after = null;
      values.hostAfter = null; values.hostCursor = null; values.disabled = command.kind === 'disabled' ? command.reason ?? null : null;
      break;
    case 'restored':
      bundleVersion(db, automation.uuid, command.digest);
      if (values.latest === command.digest) return automation;
      values.latest = command.digest;
      break;
    case 'renamed':
      if (values.name === command.name) return automation;
      values.name = command.name;
      break;
  }
  db.prepare(`UPDATE automations SET name=?,latest_digest=?,live_digest=?,activation_revision=?,activation_epoch=?,disabled_reason=?,deleted=?,
    next_at=?,event_after=?,host_pressure_after=?,host_pressure_cursor=?,revision=revision+1 WHERE id=?`)
    .run(values.name, values.latest, values.live, values.activation, values.epoch, values.disabled, +values.deleted,
      values.next, values.after, values.hostAfter, values.hostCursor ? JSON.stringify(values.hostCursor) : null, automation.uuid);
  const turningOff = command.kind === 'disabled' || command.kind === 'deleted';
  if (turningOff || swapping) {
    const pending = db.prepare(`UPDATE automation_runs SET state='skipped',phase=NULL,version=version+1,expires_at=NULL,finished_at=?,
      reason_kind=?,reason=?
      WHERE automation_id=? AND state IN ('waiting','running') AND (?=1 OR mode='live') AND attempt IS NULL RETURNING number`)
      .all(at, turningOff ? 'off' : 'version_changed', turningOff ? 'Automation turned off' : 'The enabled version changed', automation.uuid, +turningOff);
    for (const row of pending) {
      db.prepare('UPDATE automation_signal_receipts SET settled_at=? WHERE automation_id=? AND run_number=? AND settled_at IS NULL')
        .run(at, automation.uuid, row.number!);
      touch(db, { kind: 'automation_run', id: JSON.stringify([automation.id, row.number]) });
    }
    db.prepare('DELETE FROM automation_pending_skill_events WHERE automation_id=?').run(automation.uuid);
  }
  if (turningOff) {
    requestBundleStop(db, automation, now);
    db.prepare(`UPDATE automation_previews SET attempt=json_set(attempt,'$.phase','stopping')
      WHERE automation_id=? AND result IS NULL AND attempt IS NOT NULL`).run(automation.uuid);
  }
  const result = readBundleAutomation(db, automation.id);
  recordChange(db, result, command.kind, actor, at, undefined, acknowledgement);
  return result;
}

export function bundleHookChange(db: DatabaseSync, automation: BundleAutomation, operation: 'create' | 'rotate' | 'delete',
  seed: string, actor: BundleReviewer, at: string) {
  const has = db.prepare('SELECT 1 FROM automation_secrets WHERE automation_id=?').get(automation.uuid);
  if (operation === 'create' && has) return automation;
  if (operation !== 'create' && !has) throw new Problem(PROBLEM_CODE.notFound, 'HTTP hook does not exist');
  if (operation === 'delete') db.prepare('DELETE FROM automation_secrets WHERE automation_id=?').run(automation.uuid);
  else {
    const version = bundleVersion(db, automation.uuid, automation.latest);
    if (automationEvents[version.config.on.event].source !== 'signal') throw new Problem(PROBLEM_CODE.conflict, 'Only a signal automation can have an HTTP hook');
    db.prepare(`INSERT INTO automation_secrets VALUES (?,?) ON CONFLICT(automation_id) DO UPDATE SET hook_token=excluded.hook_token`)
      .run(automation.uuid, seed);
  }
  db.prepare('UPDATE automations SET revision=revision+1 WHERE id=?').run(automation.uuid);
  const result = readBundleAutomation(db, automation.id);
  recordChange(db, result, operation === 'create' ? 'hook_created' : operation === 'rotate' ? 'hook_rotated' : 'hook_deleted', actor, at);
  return result;
}

export const automationLocalDay = (timezone: string, now: Date): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);

export function automationMessageChanges(db: DatabaseSync, messageIds: readonly string[]): Map<string, AutomationMessageChange[]> {
  const changes = new Map<string, AutomationMessageChange[]>();
  const rows = db.prepare(`SELECT c.message_id,a.external_id,c.kind,c.revision,c.badge_match,c.at
    FROM automation_changes c JOIN automations a ON a.id=c.automation_id
    WHERE c.message_id IN (SELECT value FROM json_each(?)) ORDER BY c.at,a.number,c.revision`).all(JSON.stringify(messageIds));
  for (const row of rows) {
    const id = String(row.message_id), list = changes.get(id) ?? [];
    list.push({ automationId: String(row.external_id), kind: (row.kind === 'saved' ? 'edited' : row.kind) as AutomationMessageChange['kind'],
      revision: Number(row.revision), badgeMatch: row.badge_match as AutomationMessageChange['badgeMatch'], at: String(row.at) });
    changes.set(id, list);
  }
  return changes;
}
