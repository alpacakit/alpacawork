import { uiLocaleFromAcceptLanguage } from '@alpacawork/core/ui-language';
import { syncFile } from '@alpacawork/db';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, readFileSync, writeFileSync, openSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { FILE_MODE, PROBLEM_CODE, Problem, hasCode } from '@alpacawork/core';
import { defaultSettings, noticeStateSchema, readStoredSettings, personalSettings, validSetting, validSettingWrite,
  type PauseChoice, type SettingDefinition, type SettingValues } from '@alpacawork/contract';
import { morningUntil, quietEnd } from '@alpacawork/contract';
import { META_DIRECTORY } from '@alpacawork/raw';
import { FileWriter } from '../raw/storage.js';
import { applyFirstRun, firstRunSchema, type FirstRunChange, type FirstRunResponse } from '@alpacawork/contract';

type Stored<T> = { version: 1; revision: string; value: T };
const MAX_PERSON_BYTES = 1024 * 1024;

/** A rename publishes a complete file; readers need only the anchored descriptor. */
function readState<T>(writer: FileWriter, name: string, parse: (value: unknown) => T): Stored<T> | null {
  let fd = -1;
  try {
    fd = openSync(join(writer.meta, name), constants.O_RDONLY | constants.O_NONBLOCK);
    const info = fstatSync(fd);
    writer.regular(fd, info);
    if (info.size > MAX_PERSON_BYTES) throw new Error('Person state too large');
    const raw: unknown = JSON.parse(readFileSync(fd, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid person state');
    const stored = raw as Record<string, unknown>;
    if (stored.version !== 1 || typeof stored.revision !== 'string' || !stored.revision)
      throw new Error('Invalid person state envelope');
    return { version: 1, revision: stored.revision, value: parse(stored.value) };
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return null;
    throw new Problem(PROBLEM_CODE.unavailable, `Cannot read ${name}; repair the file before editing`, undefined,
      { reason: { kind: 'cannot_read_repair_file_before_editing', name: String(name) }, cause: error });
  } finally { if (fd >= 0) closeSync(fd); }
}
function readPerson<T>(root: string, name: string, parse: (value: unknown) => T): Stored<T> | null {
  const writer = new FileWriter(root);
  try { return readState(writer, name, parse); }
  finally { writer.close(); }
}
/** Feed metadata observes a revision without creating a file or blocking the Task index on a damaged personal file. */
function personRevision<T>(root: string, name: string, parse: (value: unknown) => T): string | null {
  try { return readPerson(root, name, parse)?.revision ?? null; }
  catch { return null; }
}

/** Writes alone take the RAW lock and replace the file atomically. */
async function transaction<T>(root: string, name: string, parse: (value: unknown) => T,
  operation: (current: Stored<T> | null, put: (value: T) => Stored<T>) => Stored<T> | null | Promise<Stored<T> | null>) {
  const writer = new FileWriter(root);
  try {
    return await writer.locked(async () => {
      const current = readState(writer, name, parse);
      const put = (value: T): Stored<T> => {
        const next: Stored<T> = { version: 1, revision: randomUUID(), value: parse(value) };
        const bytes = JSON.stringify(next);
        if (Buffer.byteLength(bytes) > MAX_PERSON_BYTES)
          throw new Problem(PROBLEM_CODE.tooLarge, 'Person state too large', undefined, { reason: { kind: 'person_state_too_large' } });
        const temp = `${name}.${randomUUID()}.tmp`;
        let tempFd = -1;
        let published = false;
        try {
          tempFd = openSync(join(writer.meta, temp), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, FILE_MODE);
          writeFileSync(tempFd, bytes);
          fsyncSync(tempFd);
          closeSync(tempFd); tempFd = -1;
          renameSync(join(writer.meta, temp), join(writer.meta, name));
          published = true;
          syncFile(writer.meta);
        } catch (error) {
          throw new Problem(PROBLEM_CODE.saveUnconfirmed, `Cannot confirm ${name}; reread before retrying`, undefined,
            { reason: { kind: 'cannot_confirm_reread_before_retrying', name: String(name) }, cause: error });
        } finally {
          if (tempFd >= 0) closeSync(tempFd);
          if (!published) { try { unlinkSync(join(writer.meta, temp)); } catch { /* original failure remains */ } }
        }
        return next;
      };
      return operation(current, put);
    });
  } finally { writer.close(); }
}
/** One person's observations, apart from the conversation's Request/Run facts. No per-message count limit. */
const coordinatorReadStateSchema = z.object({
  conversationId: z.string().min(1).max(256),
  seen: z.array(z.string().min(1).max(256)).refine(ids => new Set(ids).size === ids.length, 'Duplicate seen ID'),
}).strict();
export function createCoordinatorReadState(root: string) {
  const name = 'coordinator-read.json';
  const parse = (value: unknown) => coordinatorReadStateSchema.parse(value);
  return {
    get: () => readPerson(root, name, parse),
    revision: () => personRevision(root, name, parse),
    change: (operation: (current: z.infer<typeof coordinatorReadStateSchema> | null, revision: string | null) => z.infer<typeof coordinatorReadStateSchema>) =>
      transaction(root, name, parse, (current, put) => {
        const value = operation(current?.value ?? null, current?.revision ?? null);
        return current && isDeepStrictEqual(current.value, value) ? current : put(value);
      }),
  };
}
/** The revision of settings no one has saved yet: a save may start from it while no file exists. */
export const UNSAVED_SETTINGS = 'unsaved';
export function createPersonSettings(root: string, definitions: readonly SettingDefinition[] = personalSettings) {
  // The file keeps the choices made; readers see them over the defaults.
  const parse = (value: unknown) => readStoredSettings(definitions, value);
  const view = (stored: SettingValues | undefined): SettingValues => ({ ...defaultSettings(definitions), ...stored });
  const result = (state: { value: SettingValues; revision: string }) => ({ values: view(state.value), revision: state.revision });
  const changePause = async (duration: PauseChoice | null, timeZone?: string) => {
    if (timeZone !== undefined && !validSetting(definitions, 'push.timeZone', timeZone))
      throw new Problem(PROBLEM_CODE.invalidInput, 'Invalid time zone', undefined, { reason: { kind: 'invalid_time_zone' } });
    const state = await transaction(root, 'personal-settings.json', parse, (current, put) => {
      const next: SettingValues = { ...current?.value,
        ...(timeZone === undefined ? {} : { 'push.timeZone': timeZone }) };
      const now = Date.now(), seen = view(next);
      if (duration === null) {
        next['push.mutedUntil'] = null;
        const until = quietEnd(now, seen);
        next['push.quietResumedUntil'] = until ? new Date(until).toISOString() : null;
      } else {
        const until = duration === 'hour' ? now + 60 * 60_000 : duration === 'two-hours' ? now + 2 * 60 * 60_000
          : morningUntil(now, seen);
        next['push.mutedUntil'] = new Date(until).toISOString();
      }
      return put(next);
    });
    return result(state!);
  };
  return {
    revision: () => personRevision(root, 'personal-settings.json', parse),
    values: () => view(readPerson(root, 'personal-settings.json', parse)?.value),
    get: () => {
      const stored = readPerson(root, 'personal-settings.json', parse);
      return stored ? result(stored) : { values: view(undefined), revision: UNSAVED_SETTINGS };
    },
    /** The first screen navigation selects a language unless the person already chose one. */
    initializeLanguage: async (acceptLanguage: string) => {
      const language = uiLocaleFromAcceptLanguage(acceptLanguage);
      if (!language || 'language' in (readPerson(root, 'personal-settings.json', parse)?.value ?? {})) return null;
      const state = await transaction(root, 'personal-settings.json', parse, (current, put) =>
        current && 'language' in current.value ? current : put({ ...current?.value, language }));
      return state!.revision;
    },
    set: async (key: string, value: unknown, expectedRevision: string, timeZone?: string) => {
      if (!validSettingWrite(definitions, key, value))
        throw new Problem(PROBLEM_CODE.invalidInput, 'Invalid setting or value', undefined, { reason: { kind: 'invalid_setting_or_value' } });
      if (timeZone !== undefined && !validSetting(definitions, 'push.timeZone', timeZone))
        throw new Problem(PROBLEM_CODE.invalidInput, 'Invalid time zone', undefined, { reason: { kind: 'invalid_time_zone' } });
      const state = await transaction(root, 'personal-settings.json', parse, (current, put) => {
        if ((current?.revision ?? UNSAVED_SETTINGS) !== expectedRevision)
          throw new Problem(PROBLEM_CODE.conflict, 'Settings changed in another view', undefined, { reason: { kind: 'settings_changed_another_view' } });
        const next: SettingValues = { ...current?.value, [key]: value,
          ...(timeZone === undefined ? {} : { 'push.timeZone': timeZone }) };
        if (key === 'push.quiet' || key === 'push.quietFrom' || key === 'push.quietTo' ||
          (timeZone !== undefined && timeZone !== view(current?.value)['push.timeZone']))
          next['push.quietResumedUntil'] = null;
        return put(next);
      });
      return result(state!);
    },
    pause: (duration: PauseChoice, timeZone: string) => changePause(duration, timeZone),
    resume: () => changePause(null),
  };
}
/**
 * The reply language the user's AI conversations are held in (`ai.language`), or null while none is saved. Settings
 * that cannot be read name none: a launch goes on without it.
 */
export function savedReplyLanguage(root: string): string | null {
  try {
    const value = createPersonSettings(root).values()['ai.language'];
    return typeof value === 'string' ? value : null;
  } catch (error) {
    if (error instanceof Problem && error.code === PROBLEM_CODE.unavailable) return null;
    throw error;
  }
}
/** The file a new workspace's initialization writes. */
export const FIRST_RUN_FILE = 'first-run.json';
/**
 * The setup of a new workspace (`state: null` for a workspace without one). A change to a workspace without one writes
 * nothing: only initialization creates the file.
 */
export function createFirstRunState(root: string) {
  const parse = (value: unknown) => firstRunSchema.parse(value);
  return {
    get: (): FirstRunResponse => ({ state: readPerson(root, FIRST_RUN_FILE, parse)?.value ?? null }),
    change: async (change: FirstRunChange): Promise<FirstRunResponse> => {
      const stored = await transaction(root, FIRST_RUN_FILE, parse, (current, put) => {
        if (!current) return null;
        const next = applyFirstRun(current.value, change, new Date().toISOString());
        return isDeepStrictEqual(current.value, next) ? current : put(next);
      });
      return { state: stored?.value ?? null };
    },
  };
}
/**
 * The one sentence on language that every AI conversation alpacawork launches is given: the coordinator on the screen,
 * and each owner's and member's Run. It is written plainly so that the user, the project policy or another instruction
 * the agent follows can name a language for a particular output (a PR in English, a translation); which instruction
 * wins a conflict is the skill's ("Policy" in SKILL.md), not this sentence's.
 */
export const languageLine = (tag: string) =>
  `Language: ${tag} (${new Intl.DisplayNames('en', { type: 'language' }).of(new Intl.Locale(tag).language)}). ` +
  'Write your replies, progress updates included, and what you write in alpacawork (titles, values, requests, reports, ' +
  'questions, records) in this language, ' +
  'even when what you receive is written in another. ' +
  'Where the user, the project policy or other instructions you follow name a language for a particular output, ' +
  'or the work itself needs another language, follow that.\n';
export function createNoticeState(root: string) {
  const parse = (value: unknown) => noticeStateSchema.parse(value);
  // Push asks for the read marks on every look (`POLL_INTERVAL_MS`). Serve writes them over HTTP, but the file is a person's and can be put
  // back or edited by hand: what was read is kept while the file's stamp (inode, size, change time) stays, so the file
  // is read only when it changed.
  const file = join(root, META_DIRECTORY, 'notice-state.json');
  const stamp = () => {
    try { const info = lstatSync(file, { bigint: true }); return `${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`; }
    catch (error) { if (hasCode(error, 'ENOENT')) return 'absent'; throw error; }
  };
  let held: { stamp: string; state: z.infer<typeof noticeStateSchema> | null; revision: string | null } | undefined;
  return {
    revision: () => personRevision(root, 'notice-state.json', parse),
    get: async () => {
      const now = stamp();
      if (held?.stamp !== now) {
        const current = readPerson(root, 'notice-state.json', parse);
        held = { stamp: now, state: current?.value ?? null, revision: current?.revision ?? null };
      }
      return { state: held.state, revision: held.revision };
    },
    save: async (state: z.infer<typeof noticeStateSchema>, expectedRevision: string | null) => {
      try {
        const next = await transaction(root, 'notice-state.json', parse, (current, put) => {
          if ((current?.revision ?? null) !== expectedRevision)
            throw new Problem(PROBLEM_CODE.conflict, 'Notice state changed in another view', undefined, { reason: { kind: 'notice_state_changed_another_view' } });
          return put(state);
        });
        return { state: next!.value, revision: next!.revision };
      } finally {
        // What was written (or a refused save's file) is read once, by its new stamp.
        held = undefined;
      }
    },
  };
}
