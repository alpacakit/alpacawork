/** A Run receives a scoped token from its manager; CLI input cannot choose an actor. Who calls is resolveCaller's alone. */
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, openSync, readFileSync, writeSync, linkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { hasCode, Problem, PROBLEM_CODE } from '@alpacawork/core';
import { isDigest, type TaskActor } from '@alpacawork/raw';
import { runIdSchema } from '@alpacawork/contract/fields';
import { RunStore } from '@alpacawork/runs';
import type { Caller } from './authorize.js';
import { RunEventImporter } from '../runs/event-importer.js';

const FILE = 'run-credential.key';
function openKey(path: string, allowMissing: boolean): number | null {
  try { return openSync(path, constants.O_RDONLY); }
  catch (error) {
    if (allowMissing && hasCode(error, 'ENOENT')) return null;
    throw new Problem(PROBLEM_CODE.forbidden, 'Run credential key is unavailable', undefined, { reason: { kind: 'run_credential_key_unavailable' } });
  }
}

function key(root: string, create: boolean): Buffer {
  const folder = join(root, '.alpacawork'), path = join(folder, FILE);
  let fd = openKey(path, create);
  if (fd === null) {
    const generated = randomBytes(32), temporary = `.${FILE}.${randomUUID()}`;
    const directory = openSync(folder, constants.O_RDONLY | constants.O_DIRECTORY);
    let created = -1, ownsTemporary = false;
    try {
      created = openSync(join(folder, temporary), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      ownsTemporary = true;
      let offset = 0;
      while (offset < generated.length) {
        const count = writeSync(created, generated, offset, generated.length - offset);
        if (count === 0) throw new Error('Run credential key write made no progress');
        offset += count;
      }
      fsyncSync(created);
      try {
        linkSync(join(folder, temporary), path);
        unlinkSync(join(folder, temporary));
        ownsTemporary = false;
        fsyncSync(directory);
      } catch (cause) {
        if (!hasCode(cause, 'EEXIST')) throw cause;
        // Another creator published first; always read and validate its key.
      }
    } finally {
      try { if (created >= 0) closeSync(created); }
      finally {
        try { if (ownsTemporary) unlinkSync(join(folder, temporary)); }
        finally { closeSync(directory); }
      }
    }
    fd = openKey(path, false)!;
  }
  try {
    const stat = fstatSync(fd);
    if (stat.size !== 32)
      throw new Problem(PROBLEM_CODE.forbidden, 'Run credential key has invalid shape', undefined,
        { reason: { kind: 'run_credential_key_has_unsafe_permissions_or_shape' } });
    return readFileSync(fd);
  } finally { closeSync(fd); }
}
export function issueRunCredential(root: string, runId: string): string {
  const id = runIdSchema.parse(runId);
  return createHmac('sha256', key(root, true)).update(id).digest('hex');
}
export function verifyRunCredential(root: string, runId: string, token: string): boolean {
  if (!runIdSchema.safeParse(runId).success || !isDigest(token)) return false;
  let expected: Buffer;
  try { expected = createHmac('sha256', key(root, false)).update(runId).digest(); }
  catch { return false; }
  return timingSafeEqual(expected, Buffer.from(token, 'hex'));
}

type Provider = Extract<TaskActor, { kind: 'main' }>['provider'];
/**
 * What a request says about its caller, for resolveCaller to decide: a Run's credential, or the agent conversation it
 * comes from (HTTP sends them as headers; the local CLI has them in its environment). `replayOpId` names a `task report`
 * sent again under its operation ID, which its Run may have ended with.
 */
export type CallerClaim = {
  run?: { runId: string; token: string };
  direct?: { provider: Provider; conversationId: string };
  replayOpId?: string;
};

/** What resolveCaller's refusal of a Task Run's own conversation carries as its detail. */
const TASK_RUN_CONVERSATION = { conversation: 'task_run' } as const;
/**
 * Who calls: the only place that says it. A Run is known by its credential, as a current placement of its
 * Task (an owner Run only while its placement is the Task's responsible); a report sent again under its operation ID is
 * still its Run's after the Run ended with it. A conversation of a Task's Run is never the coordinator: it is refused
 * by resolveCaller. The conversation a coordinator Run runs in is the screen's; any other is an outside
 * Claude Code or Codex conversation. A Run's conversation can call before its session is imported, so one no Run owns
 * is looked up again after an import while a Run runs without its session. A screen coordinator carries its Run ID; an outside conversation needs no registration. Anyone else is a person. `store` reads the control database (null while there is none).
 *
 * A write identifies its caller once before it begins, where the import may run, and again inside its transaction on
 * `store` borrowing the write's connection: there the import never runs (`importedSessions`) and nothing else opens.
 * The read thread passes `importing` false: it never writes, and sends a caller an import could change to the main
 * thread first (`resolvingMayImport`).
 */
export function resolveCaller(root: string, claim: CallerClaim, store: RunStore | null, importing = true): Caller {
  if (claim.run) return runCaller(root, claim.run, claim.replayOpId, store);
  if (!claim.direct) return { kind: 'human' };
  const { provider, conversationId } = claim.direct;
  if (!store) return { kind: 'coordinator', source: provider, conversation: conversationId };
  let owner = store.sessionOwner([conversationId]);
  if (owner === null && importing && importedSessions(root, store)) owner = store.sessionOwner([conversationId]);
  if (owner === 'task_run')
    throw new Problem(PROBLEM_CODE.forbidden, 'This conversation belongs to an alpacawork Run', TASK_RUN_CONVERSATION,
      { reason: { kind: 'conversation_belongs_alpacawork_run' } });
  if (owner === null) return { kind: 'coordinator', source: provider, conversation: conversationId };
  return { kind: 'coordinator', source: 'screen', provider, conversation: owner.coordinator, runId: owner.runId };
}

/** Whether resolving this claim could run the import, which writes: such a caller is resolved on the server's main thread. */
export function resolvingMayImport(claim: CallerClaim, store: RunStore | null): boolean {
  if (claim.run || !claim.direct || !store) return false;
  return store.sessionOwner([claim.direct.conversationId]) === null &&
    store.connection.prepare("SELECT 1 FROM runs WHERE state='running' AND session_id IS NULL LIMIT 1").get() !== undefined;
}

function runCaller(root: string, credential: { runId: string; token: string }, replayOpId: string | undefined,
  store: RunStore | null): Caller {
  if (!verifyRunCredential(root, credential.runId, credential.token))
    throw new Problem(PROBLEM_CODE.forbidden, 'Run credential is missing or invalid', undefined, { reason: { kind: 'run_credential_missing_or_invalid' } });
  const found = store?.credentialOf(credential.runId);
  if (!store || !found) throw new Problem(PROBLEM_CODE.forbidden, 'Run is not a current placement', undefined, { reason: { kind: 'run_not_current_placement' } });
  const { run, placement } = found;
  const current = run.state === 'running' && placement !== null && placement.active && placement.taskId === run.task &&
    (run.role !== 'owner' || placement.responsible);
  if (!current && !(replayOpId !== undefined && store.connection.prepare(`SELECT 1 FROM cli_operations o
      JOIN task_log l ON l.id=o.op_id WHERE o.op_id=? AND o.operation='task/report' AND json_extract(l.entry,'$.runId')=?`)
      .get(replayOpId, run.id)))
    throw new Problem(PROBLEM_CODE.forbidden, 'Run is not a current placement', undefined, { reason: { kind: 'run_not_current_placement' } });
  return { kind: 'run', runId: run.id, placementId: run.placementId, taskId: run.task, role: run.role,
    responsible: placement?.responsible === true };
}

/**
 * A Run learns its session from its own output, so its conversation can call before the session is imported: while a
 * Run runs without one, import once, so that a Task Run's conversation is not taken for an outside coordinator, nor a
 * coordinator Run's for an outside conversation. Never inside a write: the request was identified before it, and an
 * import there would acknowledge events its write may still roll back.
 */
function importedSessions(root: string, store: RunStore): boolean {
  if (store.connection.isTransaction) return false;
  const pending = store.connection.prepare("SELECT id FROM runs WHERE state='running' AND session_id IS NULL").all();
  if (!pending.length) return false;
  // A wait for the lock would hold the server's thread, and with it the write holding the lock.
  const importer = RunStore.openExisting(root, { busyTimeoutMs: 0 });
  if (!importer) return false;
  try {
    const events = new RunEventImporter(importer), ids = pending.map(row => `R${row.id}`);
    events.pass(ids);
    events.discoverSessions(ids);
  } finally { importer.close(); }
  return true;
}
