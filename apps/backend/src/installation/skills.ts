/** Overwrite only managed names. The Store owns installation state and its final receipt. */
import { chmodSync, closeSync, cpSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { withResources } from '@alpacawork/core';
import { InstalledSkillsStore, type SkillInstallSession } from '@alpacawork/core/installed-skills';
import { syncDirectory } from './skill-files.js';
import { syncAgentSkillLinks } from './agent-skill-links.js';
import { pathSchema, requestSchema, type SkillWriteRequest, type SkillWriteResult } from './skill-write-contract.js';
export * from './skill-write-contract.js';

export class SkillWriteFailure extends Error {
  constructor(readonly operationId: string, cause: unknown) {
    super('Managed skill overwrite did not finish; resolve the logged cause and rerun skill installation from the distribution.', { cause });
  }
}
/** Make staged files writable and durable before moving them into the scan root. */
function prepareTree(path: string): void {
  const info = lstatSync(path);
  if (!info.isDirectory() && !info.isFile()) throw new Error('Distribution skills must be regular files and directories');
  chmodSync(path, info.isDirectory() || (info.mode & 0o100) ? 0o700 : 0o600);
  if (info.isDirectory()) for (const name of readdirSync(path)) prepareTree(join(path, name));
  withResources(resources => {
    const fd = openSync(path, 'r');
    resources.defer(() => closeSync(fd)); fsyncSync(fd);
  });
}
/** Outside the scan root, so a half-copied skill is never read as one. Left behind only by a writer that died. */
export const skillStage = (root: string): string => join(dirname(root), '.alpacawork-skill-stage-' + basename(root));
export class ManagedSkillsWriter {
  readonly root: string;
  private readonly detected: readonly string[];
  /** detected: the agent commands setup found. Only setup looks for commands; other callers rely on each agent's own folder. */
  constructor(input: { root: string; detected?: readonly string[] }) { this.root = pathSchema.parse(input.root); this.detected = input.detected ?? []; }
  async install(input: SkillWriteRequest, heldSession?: SkillInstallSession): Promise<SkillWriteResult> {
    const request = requestSchema.parse(input);
    try {
      mkdirSync(this.root, { recursive: true, mode: 0o700 });
      const write = (session: SkillInstallSession): SkillWriteResult => {
        const complete = session.begin({ operationId: request.operationId, release: request.release, ...request.intent });
        if (!complete) {
          const stage = skillStage(this.root);
          try {
            rmSync(stage, { recursive: true, force: true }); mkdirSync(stage, { mode: 0o700 });
            for (const name of request.intent.place) {
              cpSync(join(request.release, 'skills', name), join(stage, name), { recursive: true });
              prepareTree(join(stage, name));
            }
            for (const name of request.intent.place) {
              rmSync(join(this.root, name), { recursive: true, force: true });
              renameSync(join(stage, name), join(this.root, name));
            }
            for (const name of request.intent.remove) rmSync(join(this.root, name), { recursive: true, force: true });
            syncDirectory(this.root);
          } finally { rmSync(stage, { recursive: true, force: true }); }
        }
        // A completed replay links too: the links follow the request, whether or not this call wrote its bytes.
        syncAgentSkillLinks(this.root, request.intent, this.detected);
        return { kind: 'committed', operationId: request.operationId, receipt: complete ?? session.commit() };
      };
      return heldSession ? write(heldSession) : await new InstalledSkillsStore(this.root).session(write);
    } catch (cause) { throw new SkillWriteFailure(request.operationId, cause); }
  }
}
