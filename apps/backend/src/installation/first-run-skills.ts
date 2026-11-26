/** One screen installation job, using the same root-scoped lock as deploy and skills update. */
import { defaultUiLocale } from '@alpacawork/core/ui-language';
import { randomUUID } from 'node:crypto';
import { mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { REPOSITORY_SKILL_OFFERS, SKILL_OFFERS, skillInstallRequestSchema, type SkillJob, type SkillName, type SkillStatus, type SkillsResponse } from '@alpacawork/contract';
import { Problem, PROBLEM_CODE, parseInput, redactSecrets, hasCode } from '@alpacawork/core';
import { serverText, type ServerLocale } from '@alpacawork/i18n/server';
import { BUNDLED_SKILL_NAMES, InstalledSkillsStore } from '@alpacawork/core/installed-skills';
import { appRoot } from '../app-paths.js';
import { installationSkillsRoot } from './setup.js';
import { ManagedSkillsWriter } from './skills.js';
import { inspectAgentSkillLinks, syncAgentSkillLinks } from './agent-skill-links.js';
import { detectSetupAgents } from './setup-ai.js';
import { FirstRunCommandFailure, runFirstRunCommand, type FirstRunCommand } from './first-run-command.js';
import { InstalledRepositorySkillVersions, RepositorySkillVersions } from './repository-skill-versions.js';

const SKILLS_PACKAGE = 'skills@1.8.1';
const sourceUrl = (repo: string) => `https://github.com/${repo}.git`;
export function skillInstallCommand(raw: unknown, sha?: string): string[] {
  const { names } = parseInput(skillInstallRequestSchema, { names: [raw] });
  const offer = REPOSITORY_SKILL_OFFERS.find(offer => offer.name === names[0]);
  if (!offer) throw new Problem(PROBLEM_CODE.invalidInput, 'This skill is bundled');
  const source = sourceUrl(offer.from.repo) + (sha ? `#${sha}` : '');
  return ['--yes', SKILLS_PACKAGE, 'add', source, '--global', '--agent', 'codex', '--skill', offer.name, '--yes', '--json'];
}
export class FirstRunSkills {
  private job: SkillJob | null = null;
  private work: Promise<void> | undefined;
  private request: { opId: string; names: SkillName[] } | undefined;
  private readonly abort = new AbortController();
  readonly root: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly repositoryVersions: RepositorySkillVersions;
  private readonly installedVersions: InstalledRepositorySkillVersions;
  constructor(private readonly input: { env?: NodeJS.ProcessEnv; release?: string; run?: FirstRunCommand;
    fetchCommit?: typeof fetch; locale?: () => ServerLocale } = {}) {
    this.env = { ...input.env ?? process.env, GIT_TERMINAL_PROMPT: '0', DISABLE_TELEMETRY: '1', DO_NOT_TRACK: '1' };
    this.root = installationSkillsRoot(this.env);
    this.repositoryVersions = new RepositorySkillVersions(input.fetchCommit);
    this.installedVersions = new InstalledRepositorySkillVersions(this.root);
  }
  private installed(name: SkillName) {
    try { return !!statSync(join(this.root, name, 'SKILL.md'), { throwIfNoEntry: false })?.isFile(); }
    catch (error) { if (hasCode(error, 'ELOOP') || hasCode(error, 'ENOTDIR')) return false; throw error; }
  }
  private links(name: SkillName) { return inspectAgentSkillLinks(this.root, [name], detectSetupAgents(this.env.HOME!, this.env)); }
  private linkStatus(name: SkillName): SkillStatus['claudeLink'] {
    const links = this.links(name);
    return links.some(link => link.action === 'conflict') ? 'conflict' : links.length === 0 ? 'none'
      : links.every(link => link.action === 'keep') ? 'ok' : 'missing';
  }
  async status(): Promise<SkillsResponse> {
    const versions = this.installedVersions.read();
    const skills = SKILL_OFFERS.map(({ name, from }): SkillStatus => {
      const installed = this.installed(name);
      return { name, installed, installedAt: installed && from.kind === 'repo' ? versions[name] ?? null : null,
        available: from.kind === 'bundled' ? statSync(join(this.input.release ?? appRoot(import.meta.url), 'skills', name, 'SKILL.md'), { throwIfNoEntry: false })?.isFile() ? 'yes' : 'no' : 'unknown',
        claudeLink: this.linkStatus(name) };
    });
    return { skills, place: this.root, job: this.job ? structuredClone(this.job) : null };
  }
  latest() { return this.repositoryVersions.latest(); }
  install(raw: unknown, opId?: string): { job: SkillJob } {
    const { names } = parseInput(skillInstallRequestSchema, raw);
    if (opId && this.request?.opId === opId && this.job) {
      if (JSON.stringify(this.request.names) !== JSON.stringify(names)) throw new Problem(PROBLEM_CODE.idempotencyConflict, 'Operation ID belongs to another skill selection');
      return { job: structuredClone(this.job) };
    }
    if (this.job && !this.job.finished) throw new Problem(PROBLEM_CODE.busy, 'Skill installation is already running', { job: structuredClone(this.job) });
    if (this.abort.signal.aborted) throw new Problem(PROBLEM_CODE.unavailable, 'Server is closing');
    this.job = { id: randomUUID(), items: names.map(name => ({ name, state: 'waiting' })), finished: false };
    this.request = opId ? { opId, names: [...names] } : undefined;
    const response = { job: structuredClone(this.job) };
    this.work = this.perform(this.job).catch(() => {
      for (let at = 0; at < this.job!.items.length; at++) {
        const item = this.job!.items[at]!;
        if (item.state !== 'done' && item.state !== 'failed') this.job!.items[at] = { name: item.name, state: 'failed', reason: 'other', detail: 'Skill installation could not acquire or use the shared installation lock.' };
      }
      this.job!.finished = true;
    });
    return response;
  }
  private async perform(job: SkillJob) {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    await new InstalledSkillsStore(this.root).session(async session => {
      for (let at = 0; at < job.items.length; at++) {
        const name = job.items[at]!.name;
        job.items[at] = { name, state: 'installing' };
        try {
          if (this.abort.signal.aborted) throw new FirstRunCommandFailure('timeout');
          if (this.linkStatus(name) === 'conflict') {
            job.items[at] = { name, state: 'failed', reason: 'link_conflict', detail: 'The Claude Code skill path contains other content. It was preserved.' }; continue;
          }
          const repository = REPOSITORY_SKILL_OFFERS.find(offer => offer.name === name);
          if (repository) {
            const revision = await this.repositoryVersions.refresh(repository);
            if (this.abort.signal.aborted) throw new FirstRunCommandFailure('timeout');
            // A stopped installer may have replaced some files. Do not publish the old date for those files.
            if (this.installedVersions.read()[repository.name]) this.installedVersions.record(repository.name, null);
            await (this.input.run ?? runFirstRunCommand)('npx', skillInstallCommand(name, revision?.sha), { env: this.env, signal: this.abort.signal, timeout: 90_000 });
            if (this.installed(name)) this.installedVersions.record(repository.name, revision?.date ?? null);
          } else if (!this.installed(name)) {
            // An offer this release carries is copied from it, after the alpacawork skill it adds to.
            const bundled = BUNDLED_SKILL_NAMES.find(each => each === name);
            if (bundled && (!session.current?.receipt.skills.some(skill => skill.name === 'alpacawork') ||
              !statSync(join(this.root, 'alpacawork/SKILL.md'), { throwIfNoEntry: false })?.isFile())) {
              const t = serverText(this.input.locale?.() ?? defaultUiLocale);
              job.items[at] = { name, state: 'failed', reason: 'other', detail: t('server:setup.skills.baseMissing') }; continue;
            }
            if (bundled) await new ManagedSkillsWriter({ root: this.root }).install({ version: 2,
              operationId: randomUUID(), release: this.input.release ?? appRoot(import.meta.url), intent: { place: [bundled], remove: [] } }, session);
          }
          if (!this.installed(name)) throw new Error('The installer did not place the selected skill files. Try again or deselect this skill.');
          syncAgentSkillLinks(this.root, { place: [name], remove: [] }, detectSetupAgents(this.env.HOME!, this.env));
          if (this.linkStatus(name) === 'conflict' || this.linkStatus(name) === 'missing')
            job.items[at] = { name, state: 'failed', reason: 'link_conflict', detail: 'The Claude Code skill link could not be created.' };
          else job.items[at] = { name, state: 'done' };
        } catch (error) {
          const detail = error instanceof FirstRunCommandFailure ? error.kind === 'missing' ? 'npx is not installed or is not on the server PATH.'
            : error.kind === 'timeout' ? 'The installer exceeded its deadline or the server stopped.' : 'The installer exited unsuccessfully. Check npm and authenticated access to the skill source.'
            : redactSecrets(error instanceof Error ? `${error.message}${error.cause instanceof Error ? ': ' + error.cause.message : ''}` : String(error));
          job.items[at] = { name, state: 'failed', reason: error instanceof FirstRunCommandFailure
            ? error.kind === 'timeout' ? 'timeout' : 'npm' : 'other', detail: detail.slice(0, 4000) };
        }
      }
    }, { signal: this.abort.signal });
    job.finished = true;
  }
  async close() { this.abort.abort(); await this.work; }
}
