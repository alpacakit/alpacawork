/** One skill root owns its installation receipt and exclusive writer session. */
import { withResources, withResourcesAsync } from './resource-scope.js';
import { randomUUID } from 'node:crypto';
import { closeSync, constants, fsyncSync, statSync, lstatSync, writeFileSync, readFileSync, mkdirSync, openSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { hasCode } from './errors.js';
import { strictJson } from './json.js';
import { tryLock } from './posix.js';

/** Current distribution; retained installations may also contain private add-ons. */
export const BUNDLED_SKILL_NAMES = ['alpacawork', 'alpacawork-betterquality', 'alpacawork-modelpickoptimization'] as const;
/** Bundled skills placed only where someone chose them (in setup) or where they are already installed. */
export const OPT_IN_SKILL_NAMES: readonly ManagedSkillName[] = ['alpacawork-modelpickoptimization'];
/** Receipt names remain readable so moving a source never deletes installed content. */
export const MANAGED_SKILL_NAMES = ['alpacawork', 'alpacawork-betterquality', 'alpacawork-majority', 'alpacawork-modelpickoptimization', 'alpacawork-try-and-keep'] as const;
export const REQUIRED_MANAGED_SKILL = 'alpacawork';
/** All update callers select only names this release distributes. */
export const bundledSkillSelection = (selected: readonly ManagedSkillName[]): ManagedSkillName[] =>
  selected.filter(name => BUNDLED_SKILL_NAMES.some(bundled => bundled === name)).sort();
export type ManagedSkillName = typeof MANAGED_SKILL_NAMES[number];
/** Callers resolve their own HOME; this module never discovers another installation. */
export const managedSkillsRoot = (home: string): string => join(home, '.agents', 'skills');
/** Where a skill root keeps its receipt and writer lock; the names it lists are the only skills alpacawork owns there. */
export const skillsReceiptDirectory = (root: string): string => join(root, '.alpacawork');
const name = z.enum(MANAGED_SKILL_NAMES);
const names = z.array(name).max(MANAGED_SKILL_NAMES.length).refine(value => new Set(value).size === value.length &&
  JSON.stringify(value) === JSON.stringify([...value].sort()), 'Names must be unique and sorted');
export const skillSourceSchema = z.object({ version: z.string().max(128).regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/) }).strict();
const installedSkillSchema = z.object({ name, source: skillSourceSchema }).strict();
type InstalledSkill = z.infer<typeof installedSkillSchema>;
const installationRequestSchema = z.object({ release: z.string().min(1), place: names, remove: names }).strict()
  .refine(value => value.place.length + value.remove.length > 0 && !value.place.some(skill => value.remove.includes(skill)),
    'Installation needs disjoint, nonempty place/remove names');
const selectionSchema = z.object({ version: z.literal(2), operationId: z.uuid(), request: installationRequestSchema,
  skills: z.array(installedSkillSchema).min(1).max(MANAGED_SKILL_NAMES.length) }).strict();
const validSelection = (receipt: { skills: InstalledSkill[] }, context: z.RefinementCtx) => {
  const selected = receipt.skills.map(skill => skill.name);
  if (!names.safeParse(selected).success || !selected.includes(REQUIRED_MANAGED_SKILL))
    context.addIssue({ code: 'custom', message: 'Installed skills must be sorted, unique and contain alpacawork' });
};
export const completeSkillsReceiptSchema = selectionSchema.extend({ state: z.literal('complete') }).superRefine(validSelection);
export type CompleteSkillsReceipt = z.infer<typeof completeSkillsReceiptSchema>;
const installingSkillsReceiptSchema = selectionSchema.extend({ state: z.literal('installing') }).superRefine(validSelection);
export const skillsReceiptSchema = z.union([completeSkillsReceiptSchema, installingSkillsReceiptSchema]);
type SkillsReceipt = z.infer<typeof skillsReceiptSchema>;
type SkillsReceiptRead = { receipt: SkillsReceipt };
/** Send admission distinguishes invalid metadata from operational I/O failures. */
export class SkillsRefused extends Error {}
export interface SkillInstallSession {
  readonly current: SkillsReceiptRead | null;
  /** Save the request and intended final version table before touching bytes. */
  begin(input: { operationId: string; place: ManagedSkillName[]; remove: ManagedSkillName[]; release: string }): CompleteSkillsReceipt | null;
  /** Publish completion after the writer has placed and flushed the selected directories. */
  commit(): CompleteSkillsReceipt;
}
const RECEIPT = 'installed.json', LOCK = 'install.lock', LIMIT = 64 * 1024;
/** Node ERR_* can describe malformed input; only POSIX errno names identify I/O here. */
const ioFault = (error: unknown) => typeof error === 'object' && error !== null && 'code' in error &&
  typeof error.code === 'string' && /^E[A-Z0-9]+$/.test(error.code) && !['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error.code);
const RECEIPT_RECOVERY = 'Managed skill metadata is invalid or unsafe. Stop, preserve it and the skill bytes, and inspect them before an explicitly authorized recovery; installation does not repair metadata.';
function checkedReceipt<R>(action: () => R): R {
  try { return action(); }
  catch (error) {
    if (ioFault(error)) throw error;
    throw new SkillsRefused(RECEIPT_RECOVERY, { cause: error });
  }
}
/** Acquisition/publication owns distribution integrity; installation needs only the package version. */
function installationSkills(release: string, selected: ManagedSkillName[]): InstalledSkill[] {
  if (!selected.length) return [];
  const pkg = strictJson(readFileSync(join(release, 'package.json'))) as { version: unknown };
  const source = skillSourceSchema.parse({ version: pkg.version });
  return selected.map(name => ({ name, source }));
}

/** Metadata only lives here. Staged trees containing SKILL.md must be outside the skill scan root. */
export class InstalledSkillsStore {
  readonly root: string;
  private readonly control: string;
  constructor(root: string) {
    this.root = root; this.control = skillsReceiptDirectory(root);
    this.checkRoot();
  }
  private checkRoot(): void {
    if (!statSync(this.root).isDirectory()) throw new Error('Managed skill root must be a directory.');
  }
  private metadataDirectory(create = false): number | null {
    return checkedReceipt(() => {
      try { if (create) mkdirSync(this.control, { recursive: true, mode: 0o700 });
        return openSync(this.control, constants.O_RDONLY | constants.O_DIRECTORY); }
      catch (error) { if (!create && hasCode(error, 'ENOENT')) return null; throw error; }
    });
  }
  /** No lock and no creation: atomic publication makes one metadata read coherent. */
  read(): SkillsReceiptRead | null {
    return withResources(resources => {
      this.checkRoot();
      const directory = this.metadataDirectory();
      if (directory === null) return null;
      resources.defer(() => closeSync(directory));
      return this.readAt();
    });
  }
  /** Only the writer creates metadata. OS locks are root-scoped and are released if this process dies. */
  async session<T>(work: (session: SkillInstallSession) => Promise<T> | T, options: { signal?: AbortSignal } = {}): Promise<T> {
    return withResourcesAsync(async resources => {
      options.signal?.throwIfAborted();
      this.checkRoot(); const directory = this.metadataDirectory(true)!;
      resources.defer(() => closeSync(directory));
      const existing = this.readAt();
      const fd = openSync(join(this.control, LOCK), constants.O_RDWR | (existing ? 0 : constants.O_CREAT), 0o600);
      resources.defer(() => closeSync(fd));
      fsyncSync(fd); fsyncSync(directory);
      for (const deadline = performance.now() + 30_000; !tryLock(fd);) {
        options.signal?.throwIfAborted();
        if (performance.now() >= deadline) throw new Error('A writer still holds the skill root after 30 seconds; inspect it before a bounded retry.');
        await delay(25, undefined, { signal: options.signal });
      }
      options.signal?.throwIfAborted();

      let current = this.readAt();
      const publish = (receipt: SkillsReceipt) => {
        this.publish(directory, receipt);
        current = { receipt: structuredClone(receipt) };
      };
      let active = true;
      const perform = <R>(action: () => R): R => {
        if (!active) throw new Error('Skill installation session has ended');
        return action();
      };
      const session: SkillInstallSession = {
        get current() { return perform(() => current ? structuredClone(current) : null); },
        begin: input => perform(() => {
          const { operationId, ...request } = input;
          z.uuid().parse(operationId);
          const intent = installationRequestSchema.parse(request);
          const previous = current?.receipt;
          if (previous?.operationId === operationId && !isDeepStrictEqual(previous.request, intent))
            throw new Error('An operation ID cannot be reused for a different installation request.');
          if (previous?.state === 'installing' &&
              [...previous.request.place, ...previous.request.remove].some(skill => !intent.place.includes(skill) && !intent.remove.includes(skill)))
            throw new Error('Rerun all unfinished skill changes before completing installation.');
          const skills = new Map((previous?.skills ?? []).map(skill => [skill.name, skill]));
          for (const skill of intent.remove) skills.delete(skill);
          const selected = new Set([...skills.keys(), ...intent.place]);
          if (!selected.has(REQUIRED_MANAGED_SKILL)) throw new Error('Installation must preserve alpacawork.');
          for (const skill of installationSkills(intent.release, intent.place)) skills.set(skill.name, skill);
          const planned = completeSkillsReceiptSchema.parse({ version: 2, state: 'complete', operationId, request: intent,
            skills: [...skills.values()].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0) });
          if (previous?.operationId === operationId) {
            if (!isDeepStrictEqual(planned.skills, previous.skills))
              throw new Error('An operation ID cannot be reused for a different final skill version table.');
            if (previous.state === 'complete') return structuredClone(previous);
          }
          publish(installingSkillsReceiptSchema.parse({ ...planned, state: 'installing' }));
          return null;
        }),
        commit: () => perform(() => {
          if (current?.receipt.state !== 'installing') throw new Error('Call begin before commit.');
          const complete = completeSkillsReceiptSchema.parse({ ...current.receipt, state: 'complete' });
          publish(complete); return complete;
        }),
      };
      try { return await work(session); }
      finally { active = false; }
    });
  }
  private readAt(): SkillsReceiptRead | null {
    let bytes: Buffer;
    try { bytes = withResources(resources => {
      const fd = openSync(join(this.control, RECEIPT), constants.O_RDONLY);
      resources.defer(() => closeSync(fd));
      return readFileSync(fd);
    }); }
    catch (error) {
      if (hasCode(error, 'ENOENT')) return null;
      if (hasCode(error, 'ENOTDIR') || hasCode(error, 'ELOOP'))
        throw new SkillsRefused(RECEIPT_RECOVERY, { cause: error });
      throw error;
    }
    return checkedReceipt(() => {
      if (bytes.length > LIMIT) throw new Error('Skill receipt exceeds limit');
      lstatSync(join(this.control, LOCK));
      return { receipt: skillsReceiptSchema.parse(strictJson(bytes)) };
    });
  }
  private publish(directory: number, receipt: SkillsReceipt): void {
    const temporary = join(this.control, `receipt-${randomUUID()}.tmp`);
    withResources(resources => {
      const bytes = Buffer.from(JSON.stringify(skillsReceiptSchema.parse(receipt)) + '\n');
      if (bytes.length > LIMIT) throw new Error('Skill receipt exceeds its size limit');
      const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      const cancelUnlink = resources.defer(() => unlinkSync(temporary));
      withResources(file => {
        file.defer(() => closeSync(fd)); writeFileSync(fd, bytes); fsyncSync(fd);
      });
      renameSync(temporary, join(this.control, RECEIPT)); cancelUnlink();
      fsyncSync(directory);
    });
  }
}
