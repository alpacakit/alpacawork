/**
 * The way out: take off this PC what setup put on it, and keep the data folder.
 * It runs from the package that owns the `alpacawork` command and reads no code from the installed release,
 * so a broken or missing release cannot stop it. Each thing is found by its own evidence on disk, and the
 * installation record goes last, so a run that stopped part-way is finished by running it again.
 * The data folder outranks completeness: a folder that is the data folder, or contains it, is never removed, and
 * neither is the record that names it, so every later run protects it the same way.
 */
import { uiLocaleFromEnvironment } from '@alpacawork/core/ui-language';
import { lstatSync, readdirSync, realpathSync, rmdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { userConfigDirectory, userStateDirectory } from '@alpacawork/cli-kit';
import { localCaller } from '@alpacawork/contract/access-boundaries';
import { hasCode, platform, Problem, PROBLEM_CODE, redactSecrets, shellQuote, type ServiceDefinition, type ServiceObservation } from '@alpacawork/core';
import { InstalledSkillsStore, SkillsRefused, skillsReceiptDirectory } from '@alpacawork/core/installed-skills';
import { serverText, type ServerText } from '@alpacawork/i18n/server';
import { releasesEntries, tryHoldReleases, users } from '../release/layout.js';
import { defaultWorkspace, userHome } from '../workspace.js';
import { confirmUninstall, displayInstallationPath, uninstallKeptRows, type InstallationTerminal,
  type RefusedInstallation, type UninstallKept, type UninstallRemoval } from './confirmation.js';
import { DEFAULT_SERVICE_NAME, serviceDefinition, defaultReleases, installationSkillsRoot, underSudo } from './setup.js';
import { inspectAgentSkillLinks, syncAgentSkillLinks } from './agent-skill-links.js';
import { skillStage } from './skills.js';
import { InstallationStore, installationPath, type Installation } from './store.js';
import { assertFinishedJournalRemoval, removeFinishedJournal } from '../release/journal.js';

type Env = Readonly<Record<string, string | undefined>>;
type UninstallRequest = { env: Env; explicit?: string; yes?: boolean };
type UninstallResult = { uninstalled: true } | { uninstalled: false; reason: 'nothing_to_remove' | RefusedInstallation['reason'] };
type Step = UninstallRemoval & { run: () => void };

const exists = (path: string) => lstatSync(path, { throwIfNoEntry: false }) !== undefined;
const isFolder = (path: string) => statSync(path, { throwIfNoEntry: false })?.isDirectory() === true;
const real = (path: string) => { try { return realpathSync(path); } catch (error) { if (hasCode(error, 'ENOENT')) return path; throw error; } };
/** A folder by what it is on disk, not by how its path is spelled: a link, or a volume that ignores case, gives one folder many names. */
const identity = (path: string): string | null => {
  const info = statSync(path, { throwIfNoEntry: false, bigint: true });
  return info ? `${info.dev}:${info.ino}` : null;
};
/** `path` and every folder above it, both as the path is written and as its links resolve. */
function selfAndAbove(path: string): Set<string> {
  const found = new Set<string>();
  for (const start of new Set([path, real(path)]))
    for (let at = start; ; at = dirname(at)) {
      const id = identity(at);
      if (id) found.add(id);
      if (dirname(at) === at) break;
    }
  return found;
}
const removeIfEmpty = (folder: string) => {
  try { rmdirSync(folder); } catch (error) { if (!['ENOTEMPTY', 'ENOENT', 'ENOTDIR'].some(code => hasCode(error, code))) throw error; }
};
const failure = (cause: unknown) => displayInstallationPath(redactSecrets(cause instanceof Error ? cause.message : String(cause)));

/** For a command a person pastes: quoted for the shell, or marked as not a command when it would redraw their screen. */
const pasted = (value: string) => displayInstallationPath(value) === value ? shellQuote(value) : displayInstallationPath(value);
/** What the service adapters do, as commands for a person when uninstall cannot do it for them. */
export function serviceRemovalCommands(name: string, env: Env, host: string = process.platform): string {
  return host === 'darwin'
    ? `launchctl bootout ${pasted(`gui/${process.getuid!()}/${name}`)}\nrm -f ${pasted(join(userHome(env), 'Library/LaunchAgents', name + '.plist'))}`
    : `systemctl --user disable --now ${pasted(name)}\nrm -f ${pasted(join(dirname(userConfigDirectory(env)), 'systemd/user', name))}\nsystemctl --user daemon-reload`;
}
/**
 * What to ask the service adapter when no record describes a registration: the default name in this HOME.
 * A definition file or a loaded job under that name answers `conflict`, an unreachable manager `unavailable`;
 * only `absent` says nothing will start at the next login.
 */
export function defaultServiceDefinition(env: Env): ServiceDefinition {
  const home = userHome(env);
  return { name: DEFAULT_SERVICE_NAME, executable: process.execPath, args: [], workingDirectory: home,
    environment: { HOME: home, XDG_CONFIG_HOME: dirname(userConfigDirectory(env)) } };
}
/** What the person is told is `line`; the error itself only stops the remaining steps. */
class ServiceLeft extends Error { constructor(readonly line: string) { super('Auto-start registration was not fully removed'); } }
/** The registration goes first or nothing goes: one left behind would start, at every login, files that are no longer there. */
function serviceStep(recorded: ServiceDefinition | null, env: Env, t: ServerText, refuse: (line: string) => never): Step[] {
  const definition = recorded ?? defaultServiceDefinition(env), name = displayInstallationPath(definition.name);
  const commands = serviceRemovalCommands(definition.name, env), alreadyGone = t('server:uninstall.alreadyGone');
  const blocked = (why: string) => refuse(t('server:uninstall.service.blocked', { why, alreadyGone, commands }));
  let state: ServiceObservation['state'];
  try { state = platform.service.observe(definition).state; }
  catch (cause) { return blocked(t('server:uninstall.service.uninspectable', { name, failure: failure(cause) })); }
  if (state === 'absent') return [];
  // The commands above need the same manager, so they are not offered here.
  if (state === 'unavailable') return refuse(t('server:uninstall.service.unavailable', { name }));
  // The adapters remove only a registration they can compare with its recorded definition.
  if (!recorded) return blocked(t('server:uninstall.service.unrecorded', { name }));
  if (state === 'conflict') return blocked(t('server:uninstall.service.conflict', { name }));
  return [{ kind: 'service', subject: `${process.platform === 'darwin' ? 'launchd' : 'systemd --user'}: ${definition.name}`, run: () => {
    let fault = '';
    try { if (platform.service.stop(recorded) && platform.service.unregister(recorded)) return; }
    catch (cause) { fault = `: ${failure(cause)}`; }
    // What counts is what is there now, whatever the calls reported.
    try { if (platform.service.observe(recorded).state === 'absent') return; } catch { /* Unknown is not gone. */ }
    throw new ServiceLeft(t('server:uninstall.service.left', { name, fault, alreadyGone, commands }));
  } }];
}

/** A record that exists is the only thing that names the data folder, the releases folder and the registration. */
function unreadableRecord(path: string, env: Env, t: ServerText): string {
  const show = displayInstallationPath;
  return t('server:uninstall.unreadableRecord', { path: show(path), alreadyGone: t('server:uninstall.alreadyGone'),
    commands: serviceRemovalCommands(DEFAULT_SERVICE_NAME, env), releases: show(defaultReleases(userHome(env))), state: show(userStateDirectory(env)),
    receipt: show(join(skillsReceiptDirectory(installationSkillsRoot(env)), 'installed.json')), config: show(userConfigDirectory(env)) });
}

/** Read-only. Everything listed exists now; `keep` is what uninstall will not touch and why. */
function inspectUninstall(env: Env, t: ServerText, refuse: (line: string) => never) {
  const home = userHome(env), store = new InstallationStore(installationPath(env)), config = userConfigDirectory(env);
  let record: Installation | null;
  // No record file leaves the default places to look in. A record that is there but unreadable leaves nothing safe to assume.
  try { record = store.read(); }
  catch (error) { if (!(error instanceof Problem)) throw error; return refuse(unreadableRecord(store.path, env, t)); }
  const releases = record?.releases ?? defaultReleases(home);
  // The default data folder is protected with or without a record: a product folder `<XDG folder>/alpacawork` can be that very folder.
  // A data folder that is no longer there protects nothing, so a person who deleted it can still finish.
  const data = [...(record ? [record.workspace] : []), defaultWorkspace(home)].filter(exists);
  const keep: UninstallKept[] = record && data.includes(record.workspace) ? [{ kind: 'data', subject: record.workspace }] : [];
  const steps = serviceStep(record?.service ? serviceDefinition(record, store.path) : null, env, t, refuse);
  let journal: { releases: string; workspace: string } | null = null;
  const aboveHome = selfAndAbove(home), aboveData = new Set(data.flatMap(folder => [...selfAndAbove(folder)]));
  const removable = (subject: string): boolean => {
    // A trailing separator makes every later call follow a link into the folder it names.
    if (resolve(subject) !== subject) throw new Problem(PROBLEM_CODE.unsafePath, `Recorded folder is not a normalized path: ${subject}`);
    const id = identity(subject);
    // Setup refuses these places; a record edited by hand must not turn a removal into the person's HOME.
    if (id && aboveHome.has(id)) throw new Problem(PROBLEM_CODE.unsafePath, `Product directory must be separate from HOME and its parents: ${subject}`);
    if (id && aboveData.has(id)) { keep.push({ kind: 'holds_data', subject }); return false; }
    return true;
  };
  const path = (kind: Step['kind'], subject: string) => {
    if (exists(subject) && removable(subject)) steps.push({ kind, subject, run: () => rmSync(subject, { recursive: true, force: true }) });
  };

  const root = installationSkillsRoot(env);
  let receipt: ReturnType<InstalledSkillsStore['read']> | 'unreadable' = null;
  try { if (isFolder(root)) receipt = new InstalledSkillsStore(root).read(); }
  catch (error) { if (!(error instanceof SkillsRefused)) throw error; receipt = 'unreadable'; }
  // Only the receipt says which skills are alpacawork's. Without a readable one, none is removed on a guess.
  if (receipt === 'unreadable') keep.push({ kind: 'skills_unknown', subject: root });
  else {
    // The store keeps no record of local edits and setup overwrites them without a backup; removal follows the same rule.
    const names = receipt?.receipt.skills.map(skill => skill.name) ?? [];
    // Only a link that points at the managed skill goes, and it is read again at removal; anything else is the person's own.
    for (const name of names) for (const link of inspectAgentSkillLinks(root, [name], []))
      if (link.action === 'keep') steps.push({ kind: 'link', subject: link.path, run: () => syncAgentSkillLinks(root, { place: [], remove: [name] }, []) });
    for (const name of names) path('skill', join(root, name));
    path('stage', skillStage(root));
    // The receipt goes after the skills it lists, so an interrupted removal still knows which are alpacawork's.
    path('receipt', skillsReceiptDirectory(root));
  }
  // Serve keeps its state under the HOME its service definition names; the CLI under the caller's XDG_STATE_HOME.
  for (const state of new Set([userStateDirectory(env), ...(record?.service ? [userStateDirectory(serviceDefinition(record, store.path).environment)] : [])]))
    path('state', state);
  // Setup accepts any folder as releases, also one the person uses for other things: only alpacawork's own entries go.
  if (isFolder(releases) && removable(releases)) {
    const found = releasesEntries(releases);
    // Setup made the default parent only to hold releases; the parent of a folder the person chose is theirs.
    const parent = dirname(releases), ownParent = identity(parent) !== null && identity(parent) === identity(dirname(defaultReleases(home)));
    if (found.other.length) keep.push({ kind: 'not_ours', subject: releases });
    if (found.own.length || !found.other.length) {
      const place = { releases, workspace: record?.workspace ?? defaultWorkspace(home) };
      assertFinishedJournalRemoval(place);
      journal = place;
      steps.push({ kind: 'releases', subject: releases, run: () => {
        removeFinishedJournal(place);
        // Read again: the lock taken after approval is an entry too, and each is still told apart by its name.
        for (const entry of releasesEntries(releases).own) rmSync(entry, { recursive: true, force: true });
        removeIfEmpty(releases);
        if (ownParent) removeIfEmpty(parent);
      } });
    }
  }
  // Last: the record names the data folder, the releases folder and the service definition that a rerun needs.
  if (exists(config) && removable(config)) {
    if (record && keep.some(item => item.kind === 'holds_data')) {
      for (const name of readdirSync(config)) if (join(config, name) !== store.path) path('setting', join(config, name));
      keep.push({ kind: 'record', subject: store.path });
    } else steps.push({ kind: 'config', subject: config, run: () => rmSync(config, { recursive: true, force: true }) });
  }
  return { steps, keep, releases, journal, recorded: record !== null };
}

/**
 * Processes started from a release folder: agents (Run managers and what they run) and updates. Serve names only
 * `current`. A Run's command line carries the real path, which is not how a HOME reached through a link spells it.
 */
function runningFrom(releases: string): number[] {
  const processes = platform.run.processes().filter(process_ => process_.pid !== process.pid);
  return [...new Set([...new Set([releases, real(releases)])].filter(isFolder).flatMap(folder =>
    readdirSync(folder, { withFileTypes: true }).filter(entry => entry.isDirectory())
      .flatMap(entry => users(join(folder, entry.name), processes, false)).map(user => user.pid)))];
}

export async function runUninstall(request: UninstallRequest, say: (line: string) => void, terminal?: InstallationTerminal): Promise<UninstallResult> {
  const { env } = request, t = serverText(uiLocaleFromEnvironment(env));
  const refuse = (line: string, code: Problem['code'] = PROBLEM_CODE.conflict): never => {
    say(line);
    throw new Problem(code, 'Uninstall did not start. Nothing was changed.');
  };
  if (localCaller.claimsRun(env)) refuse(t('server:uninstall.refused.agent'), PROBLEM_CODE.forbidden);
  if (underSudo(env)) refuse(t('server:uninstall.refused.sudo'), PROBLEM_CODE.unsafePath);
  if (!request.yes && (!(terminal?.input ?? process.stdin).isTTY || !(terminal?.output ?? process.stdout).isTTY))
    refuse(t('server:uninstall.refused.notTerminal'), PROBLEM_CODE.invalidInput);
  if (request.explicit !== undefined) refuse(t('server:uninstall.refused.workspaceOption'), PROBLEM_CODE.invalidInput);

  const plan = inspectUninstall(env, t, refuse);
  if (!plan.steps.length) {
    say(plan.recorded ? t('server:uninstall.nothingLeft') : t('server:uninstall.notInstalled'));
    for (const row of uninstallKeptRows(plan.keep, t)) say(row);
    say(t('server:uninstall.remaining'));
    return { uninstalled: false, reason: 'nothing_to_remove' };
  }
  // Runs are detached from serve and outlive it. Removing the installation would leave them working with nothing
  // watching them, on code deleted under them; like a release switch, uninstall waits for them and never ends them.
  const assertIdle = () => {
    const pids = runningFrom(plan.releases);
    if (pids.length) refuse(t('server:uninstall.running', { count: pids.length, releases: displayInstallationPath(plan.releases), pids: pids.join(', ') }));
  };
  assertIdle();
  const approval = await confirmUninstall({ remove: plan.steps, keep: plan.keep }, terminal, { yes: request.yes });
  if (!approval.approved) return { uninstalled: false, reason: approval.reason };

  // The same lock as deploy, update and setup: none of them may switch or publish while its folder is removed.
  const unlock = isFolder(plan.releases) ? tryHoldReleases(plan.releases) : () => {};
  if (!unlock) return refuse(t('server:uninstall.busy'));
  try {
    assertIdle();
    if (plan.journal) assertFinishedJournalRemoval(plan.journal);
    for (const step of plan.steps) {
      const subject = displayInstallationPath(step.subject);
      try { step.run(); }
      catch (cause) {
        say(cause instanceof ServiceLeft ? cause.line : t('server:uninstall.stoppedAt', { subject, failure: failure(cause) }));
        throw new Error('Uninstall did not complete', { cause });
      }
      say(t('server:uninstall.removed', { subject }));
    }
  } finally { unlock(); }
  say(t('server:uninstall.done'));
  for (const row of uninstallKeptRows(plan.keep, t)) say(row);
  say(t('server:uninstall.remaining'));
  return { uninstalled: true };
}
