import { applyEnvironmentFile } from '../environment-file.js';
import type { InspectionEnvironment } from '../agents/availability.js';
import { readAgentsSettings } from '../agents-settings.js';
/** Public setup connects the existing installation, writer and switch Owners. */
import { applyDeployArtifact } from './deploy.js';
import { randomUUID } from 'node:crypto';
import { InstalledSkillsStore } from '@alpacawork/core/installed-skills';
import { realpathSync, statSync, lstatSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runMaintenance } from '../release/maintenance-process.js';
import { backendEntry, appRoot } from '../app-paths.js';
import { hasCode, platform, Problem, PROBLEM_CODE, redactSecrets, type ServiceDefinition } from '@alpacawork/core';
import { readPackageVersion } from '@alpacawork/core/package-version';
import { uiLocaleFromEnvironment } from '@alpacawork/core/ui-language';
import { serverText, type ServerLocale, type ServerText } from '@alpacawork/i18n/server';
import { inspectWorkspace, selectWorkspace, validateSetupLocations, userHome, workspaceArgument, type WorkspaceRequest } from '../workspace.js';
import { holdReleases, releasePath, linkTarget } from '../release/layout.js';
import { publishSelfRelease } from '../release/build.js';
import { assertUpdateHandoff } from '../release/update-capabilities.js';
import { saveJournal, loadJournal, terminal as ended, recovering } from '../release/journal.js';
import { parseTargets } from '../release/package-closure.js';
import { absolutePath, assertProductDirectory } from './files.js';
import { InstallationStore, installationPath } from './store.js';
import { initializeInstallation, registerInstallation, validateNewWorkspace, inspectInstallationService, recordInstallationService, readInstallationService, installationSkillsRoot, probeServicePort, serviceDefinition, servicePort, servicePublicHost, serviceMcp, defaultReleases } from './setup.js';
import { skillLinkConflicts, confirmInstallation, displayInstallationPath, type InstallationChange, type InstallationConfirmationRequest, type InstallationTerminal } from './confirmation.js';
import { ManagedSkillsWriter, SkillWriteFailure, equal, type SkillWriteRequest } from './skills.js';
import { completeSetup, finishSetupSkills, newSetupSkills, readSetupSkills, saveSetupSkills } from './setup-skills.js';
import { detectSetupAgents } from './setup-ai.js';
import { inspectAgentSkillLinks } from './agent-skill-links.js';
import { canonicalLanguageTag } from '@alpacawork/contract';
import { localCaller } from '@alpacawork/contract/access-boundaries';
import { inspectMcpTailnet } from './tailnet-mcp.js';
import { setupAgentName } from './setup-output.js';
import { switchTo, ServiceStartRequired, ServiceNotReady, assertWorkspaceStopped, assertPortChangeable, replaceService } from '../release/switch.js';
import { readUpdateRecord, completedUpdate } from '../release/update-record.js';

export type InstallationResult = {installed:false;reason:string;plan?:unknown;confirm?:string} |
  {installed:true;operation?:'change'|'update';url?:string;port?:number;version:string;opId?:string;workspace?:string;release?:string;generation?:string};
export type SetupArtifact = {facts: {name: string; version: string; source: string; edition: import('../release/layout.js').ReleaseKind; targets: string[]};
  publish: (releases: string, say: (line: string) => void) => Promise<string>};
export type SetupRequest = Omit<WorkspaceRequest, 'record' | 'intent'> & { releases?: string; service?: string; port?: number; publicHost?: string; artifact?: SetupArtifact;
  mcp?: boolean; confirmPrivateTailnet?: boolean; language?: string; yes?: boolean; onFailure?: (line: string) => void; onReady?: (url: string) => void };
/** Read-only selection. The workspace Owner enforces all existing/explicit/default conflicts. */
export function inspectSetup(request: SetupRequest) {
  if (request.language !== undefined && !canonicalLanguageTag(request.language)) throw new Problem(PROBLEM_CODE.invalidInput, '--lang must be a BCP 47 language tag');
  const store = new InstallationStore(installationPath(request.env));
  const record = store.read();
  const selected = selectWorkspace({ ...request, record, intent: 'setup' });
  const existing = inspectWorkspace(selected.root).state === 'initialized';
  const releases = workspaceArgument(request.releases ?? record?.releases ?? defaultReleases(userHome(request.env)), request.cwd, userHome(request.env));
  validateSetupLocations(selected.root, releases, existing);
  assertProductDirectory(releases, userHome(request.env)); assertProductDirectory(dirname(store.path), userHome(request.env));
  // Apply the installation Owner's host rules to every prospective write location before confirmation.
  for (const path of [userHome(request.env), store.path, selected.root, releases]) validateNewWorkspace(path, request.env);
  if (existsSync(releases) && !statSync(releases).isDirectory()) throw new Error('Releases path must be a directory');
  if (record && record.releases !== null && record.releases !== releases)
    throw new Problem(PROBLEM_CODE.conflict, `Requested releases ${releases} differs from recorded releases ${record.releases}; use the recorded releases path ${record.releases}, then run setup again`);
  const source = absolutePath(realpathSync(appRoot(import.meta.url)));
  const facts = request.artifact?.facts ?? readPackageVersion(source);
  return { workspace: selected.root, releases, existing, facts, installation: record };
}

export type SetupPlan = ReturnType<typeof inspectSetup>;
/** Confirmation takes workspace state from inspection, never a separately assembled display flag. */
export function confirmSetup(plan: SetupPlan,
  observations: Pick<InstallationConfirmationRequest, 'service' | 'agents' | 'skills' | 'links' | 'overwrite' | 'resuming' | 'notes'>, terminal?: InstallationTerminal, options: { yes?: boolean; showReleases?: boolean } = {}) {
  return confirmInstallation({ ...observations, showReleases: options.showReleases, workspace: plan.workspace, releases: plan.releases, existing: plan.existing, application:{current:plan.installation?.releases ? importCurrent(plan.releases) : null,target:plan.facts.version} }, terminal, options);
}

const serviceManager = () => process.platform === 'darwin' ? 'launchd' : 'systemd --user';
export function serviceDescription(definition: ServiceDefinition, t: ReturnType<typeof serverText>): string {
  const host = servicePublicHost(definition);
  return t('server:setup.service.summary', { name: definition.name, manager: serviceManager(), port: servicePort(definition) }) +
    (host ? t('server:setup.service.publicHost', { host }) : '');
}
/** Setup changes only a registration it can read as its own or as absent. */
function observeService(definition: ServiceDefinition) {
  const observation = platform.service.observe(definition);
  if (observation.state === 'unavailable') throw new Error('User service manager is unavailable. Start your user service manager/session, then run setup again. On WSL2, enable systemd and restart WSL first.');
  if (observation.state === 'conflict') throw new Error(`User service definition conflicts with this installation. Inspect the existing ${definition.name} definition and use its recorded HOME, workspace and releases before running setup again. If its definition file no longer exists, the manager still holds the removed one: reload it first (systemd: systemctl --user daemon-reload).`);
  return observation;
}
/** Every caller but setup's re-approval uses a recorded service as recorded, and is told the fix when it names another. */
export function requestedInstallationService(plan: Pick<SetupPlan, 'workspace' | 'releases'>, request: Pick<SetupRequest, 'env' | 'service' | 'port' | 'publicHost' | 'mcp'>) {
  const managed = readInstallationService({ workspace: plan.workspace, releases: plan.releases, env: request.env });
  if (request.service !== undefined && request.service !== managed.definition.name)
    throw new Problem(PROBLEM_CODE.conflict, 'Requested service differs from the recorded service; the service name of an installation cannot be changed');
  if (request.port !== undefined && request.port !== managed.port || request.publicHost !== undefined && request.publicHost !== servicePublicHost(managed.definition))
    throw new Problem(PROBLEM_CODE.conflict, 'Requested port or public host differs from the recorded installation; run alpacawork setup --port/--public-host from a terminal to change it');
  if (request.mcp !== undefined && request.mcp !== serviceMcp(managed.definition))
    throw new Problem(PROBLEM_CODE.conflict, 'Requested MCP setting differs from the installation; change it with alpacawork setup --mcp from a terminal');
  return managed;
}
/** A first approval proposes this terminal's definition; a recorded service is shown and resumed as recorded. */
async function servicePreview(plan: SetupPlan, request: SetupRequest) {
  const definition = plan.installation?.service ? requestedInstallationService(plan, request).definition
    : await inspectInstallationService(plan.releases, plan.workspace, request.env, request.service, {port:request.port,publicHost:request.publicHost,mcp:request.mcp});
  observeService(definition);
  return { definition, description: serviceDescription(definition, serverText(uiLocaleFromEnvironment(request.env))) };
}
async function mcpSetupNotes(port: number, request: SetupRequest, t: ServerText) {
  const exposure = await inspectMcpTailnet(port, request.env);
  if (exposure === 'funnel')
    throw new Problem(PROBLEM_CODE.forbidden, t('server:setup.mcp.funnel', { port }));
  if (exposure === 'unknown' && !request.confirmPrivateTailnet)
    throw new Problem(PROBLEM_CODE.invalidInput, t('server:setup.mcp.verify'));
  return [t('server:setup.mcp.access'), t('server:setup.mcp.settings'), t('server:setup.mcp.inspect'),
    t('server:setup.mcp.runs'), t(exposure === 'unknown' ? 'server:setup.mcp.confirmed' : 'server:setup.mcp.private')];
}

/** What must finish before setup may change the service, read from the saved state alone: between two controllers
 * of one update no process is alive, and the journal still says the switch is under way. */
function pendingOperation(plan: SetupPlan): { what: string; finish: string } | null {
  if (readSetupSkills(plan.releases)) return { what: 'A saved setup', finish: 'run alpacawork setup without changed options to resume it' };
  const journal = loadJournal({ releases: plan.releases, workspace: plan.workspace }), update = readUpdateRecord(plan.releases).operation;
  if (journal && !ended(journal)) return recovering(journal)
    ? { what: 'A database recovery', finish: 'resume the same recovery (alpacawork-backend release recover with its backup)' }
    : { what: 'A release switch', finish: 'run the alpacawork deploy or setup that started it again, or wait for the update shown on the screen' };
  if (update && update.phase !== 'failed' && !completedUpdate(plan.releases, update, journal))
    return { what: 'An update', finish: 'wait for the update shown on the screen, or cancel it there' };
  return null;
}
/**
 * `alpacawork setup` alone re-approves the recorded service of a settled installation. The terminal shows each
 * recorded fact that differs from what this terminal would approve (port, public host, Node.js path); Enter replaces
 * the record, the registered definition and the running service, and setup ends there. The terminal's PATH alone is
 * no change: it is taken, and shown, only with one the person confirms. Null: nothing to approve, setup goes on.
 */
async function reapproveService(plan: SetupPlan, request: SetupRequest, say: (line: string) => void, terminal?: InstallationTerminal): Promise<InstallationResult | null> {
  if (!plan.installation?.service) return null;
  const recorded = serviceDefinition(plan.installation, installationPath(request.env));
  const approved = await inspectInstallationService(plan.releases, plan.workspace, request.env, request.service, {port:request.port,publicHost:request.publicHost,mcp:request.mcp});
  const port = servicePort(approved), old = servicePort(recorded), portChanges = old !== port;
  const language = uiLocaleFromEnvironment(request.env), t = serverText(language);
  const mcp = serviceMcp(approved), mcpChanged = mcp !== serviceMcp(recorded);
  const facts: InstallationChange[] = [
    ...(mcpChanged ? [{ fact: 'mcp' as const, from: t(mcp ? 'server:setup.mcp.off' : 'server:setup.mcp.on'),
      to: t(mcp ? 'server:setup.mcp.on' : 'server:setup.mcp.off') }] : []),
    ...(portChanges ? [{ fact: 'port' as const, from: String(old), to: String(port) }] : []),
    ...(servicePublicHost(recorded) !== servicePublicHost(approved) ? [{ fact: 'publicHost' as const, from: servicePublicHost(recorded) ?? null, to: servicePublicHost(approved)! }] : []),
    ...(recorded.executable !== approved.executable ? [{ fact: 'node' as const, from: recorded.executable, to: approved.executable }] : []),
  ];
  // A settled installation whose service the manager does not hold is what an interrupted change leaves: register it again.
  if (!facts.length && (pendingOperation(plan) || platform.service.known(recorded.name))) return null;
  /** Nothing is stopped, removed or written while another operation owns the service. */
  const refusePending = () => {
    const pending = pendingOperation(plan);
    if (pending) throw new Problem(PROBLEM_CODE.conflict, recorded.executable === approved.executable
      ? `${pending.what} is in progress, so setup does not change the service now. First ${pending.finish}; then run this command again. Nothing was changed`
      : `${pending.what} is in progress and can finish only under the Node.js it was approved with, ${recorded.executable}. Node.js is now ${approved.executable}, which setup approves only when nothing is in progress. Install Node.js at ${recorded.executable} again and, running under it, ${pending.finish}; then run alpacawork setup again to approve the new path. Nothing was changed`);
  };
  refusePending(); observeService(recorded);
  const replaces = facts.length ? recorded : null, release = linkTarget(plan.releases, 'current')!;
  const place = { releases: plan.releases, workspace: plan.workspace, service: recorded.name, say };
  /** A port moves only to a free one, and only when no Run would keep calling the old one. */
  const assertPortMoves = async (stopped: string | null) => {
    if (!portChanges) return;
    await assertPortChangeable(place, stopped);
    await probeServicePort(port).catch(cause => { throw new Problem(PROBLEM_CODE.conflict, `Port ${port} cannot be used (${hasCode(cause, 'EADDRINUSE') ? 'another process is using it' : cause instanceof Error ? cause.message : String(cause)}); choose another --port. Nothing was changed`, undefined, { cause }); });
  };
  await assertPortMoves(null);
  const notes = mcp && (mcpChanged || portChanges || servicePublicHost(recorded) !== servicePublicHost(approved))
    ? await mcpSetupNotes(port, request, t) : [];
  const approval = await confirmInstallation({ workspace: plan.workspace, releases: plan.releases, showReleases: request.releases !== undefined, existing: true, agents: [], skills: [],
    application: { current: readPackageVersion(release).version, target: readPackageVersion(release).version },
    changes: replaces && recorded.environment.PATH !== approved.environment.PATH ? [...facts, { fact: 'path', from: recorded.environment.PATH ?? null, to: approved.environment.PATH! }] : facts,
    service: serviceDescription(approved, t), notes }, terminal, { yes: request.yes });
  if (!approval.approved) return { installed: false, reason: approval.reason };
  const unlock = holdReleases(plan.releases);
  try {
    // Read again under the release lock: the confirmation took time, and a stopped serve can now be read for its Runs.
    refusePending(); await assertPortMoves(release);
    if (notes.length) await mcpSetupNotes(port, request, t);
    const ready = await replaceService(place, replaces, async () => {
      // With serve stopped no Run can start any more; one that started just before it keeps the old port.
      if (portChanges) await assertPortChangeable(place, release);
      await recordInstallationService(plan.releases, plan.workspace, approved, request.env, recorded);
    }).catch(cause => {
      if (!(cause instanceof ServiceNotReady)) throw cause;
      return startFailure(cause, plan.releases, recorded.name, language, request.onFailure ?? say, portChanges ? `\n${t('server:setup.portWayBack', { port: old })}` : '');
    });
    if (Number(new URL(ready.url).port || 80) !== port) throw new Error('HTTP-ready URL port differs from the approved installation port; preserve this installation.');
    say(replaces ? t('server:setup.readyChanged', { port, url: ready.url }) : t('server:setup.ready', { port, url: ready.url }));
    return { installed: true, operation: 'change', url: ready.url, port, version: readPackageVersion(release).version };
  } finally { unlock(); }
}
/** After the approved service may have been stopped or replaced: what to keep, why it stopped and where to look. */
function startFailure(cause: unknown, releases: string, service: string, language: ServerLocale, say: (line: string) => void, wayBack = ''): never {
  const reason = redactSecrets(cause instanceof Error ? cause.message : String(cause)), t = serverText(language);
  const advice = redactSecrets(setupFailureAdvice(cause, releases));
  say(`${t('server:setup.startFailure.keep')}\n${t('server:setup.startFailure.reason', { reason: reason.replace(/\s*[\r\n]+\s*/g, ' ') })}${advice === reason ? '' : `\n${advice}`}\n${serviceStartupAdvice(service, language, process.platform, cause)}${wayBack}`);
  throw new Error('Setup did not complete', { cause });
}
function overwriteLines(request: SkillWriteRequest, root: string, t: ServerText): string[] {
  return request.intent.place.filter(name => lstatSync(join(root, name), { throwIfNoEntry: false }) !== undefined)
    .map(name => t('server:setup.overwriteSkill', { path: displayInstallationPath(join(root, name)) }));
}
function assertTerminal(terminal?: InstallationTerminal, yes = false): void {
  if (!yes && (!(terminal?.input ?? process.stdin).isTTY || !(terminal?.output ?? process.stdout).isTTY))
    throw new Problem(PROBLEM_CODE.invalidInput, 'Run setup from a terminal, or add --yes to go ahead without asking. No setup changes were made.');
}
/** Only switchTo's actual HTTP readiness can produce a successful setup URL. */
export async function runSetup(request: SetupRequest, say: (line: string) => void, terminal?: InstallationTerminal): Promise<InstallationResult> {
  if (localCaller.claimsRun(request.env)) throw new Problem(PROBLEM_CODE.forbidden, 'Run setup as the intended user, not from an agent Run. No setup changes were made.');
  assertTerminal(terminal, request.yes);
  let plan: SetupPlan;
  try { plan = inspectSetup(request); }
  catch (cause) {
    // Translate only the human setup boundary; the CLI still receives the original structured refusal.
    const t = serverText(uiLocaleFromEnvironment(request.env));
    const kind = cause instanceof Problem ? cause.reason?.kind : undefined;
    const reason = kind === 'installation_wsl_filesystem_refused' ? t('server:setup.wslFilesystem.refused')
      : kind === 'installation_wsl_filesystem_unknown' ? t('server:setup.wslFilesystem.unknown') : null;
    if (reason) (terminal?.output ?? process.stdout).write(`${reason}\n${t('server:setup.wslFilesystem.retry')}\n`);
    throw cause;
  }
  const changed = await reapproveService(plan, request, say, terminal);
  if (changed) return changed;
  const current=plan.installation?.releases ? linkTarget(plan.releases,'current') : null;
  if (plan.installation?.service && current && current!==releasePath(plan.releases,plan.facts) && !readSetupSkills(plan.releases)) {
    const artifact=request.artifact ?? {facts:plan.facts,publish:async(releases:string,log:(line:string)=>void)=>{
      const unlock=holdReleases(releases);try{return await publishSelfRelease(releases,{source:plan.facts.source,edition:plan.facts.edition,targets:parseTargets(plan.facts.targets.join(','))},log);}finally{unlock();}
    }};
    const result = await applyDeployArtifact(request,artifact,say,terminal);
    return result.installed ? { ...result, operation: 'update' } : result;
  }
  return performSetup(plan, request, say, terminal);
}
/** A first installation or the resume of a saved setup. Deploy reaches setup only here, so it approves no changed fact. */
export async function installSetup(request: SetupRequest, say: (line: string) => void, terminal?: InstallationTerminal): Promise<InstallationResult> {
  assertTerminal(terminal, request.yes);
  return performSetup(inspectSetup(request), request, say, terminal);
}
async function performSetup(plan: SetupPlan, request: SetupRequest, say: (line: string) => void, terminal?: InstallationTerminal): Promise<InstallationResult> {
  const root = installationSkillsRoot(request.env);
  const prior = readSetupSkills(plan.releases), target = releasePath(plan.releases, plan.facts);
  if (prior && (prior.workspace !== plan.workspace || prior.root !== root || prior.request.release !== target))
    throw new Error('Saved setup belongs to another selection/package. Preserve its journal and finish that setup before using the normal update flow.');
  if ((!plan.installation?.service) && !prior && plan.existing) await assertWorkspaceStopped(plan.workspace);
  const service = await servicePreview(plan, request);
  const agentEnvironment = { cwd: service.definition.workingDirectory, env: { ...service.definition.environment } };
  const agents = detectSetupAgents(agentEnvironment.cwd, agentEnvironment.env);
  const writer = new ManagedSkillsWriter({ root, detected: agents });
  const intent = { place: ['alpacawork' as const], remove: [] };
  const writeRequest: SkillWriteRequest = prior?.request ?? { version: 2, operationId: randomUUID(), release: target, intent };
  const receipt = statSync(root, { throwIfNoEntry: false }) ? new InstalledSkillsStore(root).read()?.receipt : null;
  const alreadyComplete = receipt?.state === 'complete' && receipt.operationId === writeRequest.operationId;
  const language = uiLocaleFromEnvironment(request.env), t = serverText(language);
  const notes = serviceMcp(service.definition) && !plan.installation?.service
    ? await mcpSetupNotes(servicePort(service.definition), request, t) : [];
  const approval = await confirmSetup(plan, { notes, service: service.description, agents: agents.map(setupAgentName), links: inspectAgentSkillLinks(root, writeRequest.intent.place, agents),
    skills: [
      { name: 'alpacawork', destination: join(root, 'alpacawork'), action: alreadyComplete ? 'keep' : statSync(join(root, 'alpacawork'), { throwIfNoEntry: false }) ? 'replace' : 'install' },
      ...(receipt?.state === 'complete' ? receipt.skills : []).filter(s => s.name !== 'alpacawork').map(s => ({ name: s.name, destination: join(root, s.name), action: 'keep' as const })),
    ], overwrite: alreadyComplete ? [] : overwriteLines(writeRequest, root, t), resuming: !!prior }, terminal, { yes: request.yes, showReleases: request.releases !== undefined });
  if (!approval.approved) return { installed: false, reason: approval.reason };
  if (!plan.existing) applyEnvironmentFile(agentEnvironment.env);
  const prepared = await prepareSetup(request, plan, say, agentEnvironment);
  let starting = false;
  try {
    const settings = readAgentsSettings(plan.workspace);
    if (settings.ok) say(t('server:setup.agents.enabled', { names: Object.entries(settings.config.agents)
      .filter(([, setting]) => setting.enabled !== false).map(([name]) => name).join(', ') || t('server:setup.agents.none') }));
    if (!equal(readSetupSkills(plan.releases), prior)) throw new Error('Setup journal changed after confirmation. Run setup again.');
    if (prepared.release !== writeRequest.release) throw new Error('Prepared release differs from the approved skill request.');
    const saved = prior ?? newSetupSkills(plan.workspace, root, writeRequest);
    if (!prior) saveSetupSkills(plan.releases, saved);
    await recordInstallationService(plan.releases, plan.workspace, service.definition, request.env);
    await finishSetupSkills(plan.releases, saved, writer, say);
    for (const line of skillLinkConflicts(inspectAgentSkillLinks(root, saved.request.intent.place, agents), language)) say(line);
    const installedService = readInstallationService({ releases: plan.releases, workspace: prepared.installation.workspace, env: request.env });
    starting = true;
    const ready = await switchTo({ releases: installedService.installation.releases, workspace: installedService.installation.workspace,
      service: installedService.definition.name, say }, prepared.release, plan.facts.edition, {
      reservePrepared: async journal => {
        // Initial setup has already completed its managed skill request. The switch journal owns irreversibility.
        journal.skillsWriteStarted=true;
        saveJournal({releases:plan.releases,workspace:plan.workspace},journal);
      }, afterStopped: async journal => {
        const result = JSON.parse(await runMaintenance(process.execPath,[backendEntry('release/update-controller',prepared.release), 'setup',plan.workspace,journal.opId],{...request.env},say,'Setup target continuation'));
        if (result.error) {
          if (result.error.service) throw new ServiceStartRequired(result.error.service);
          throw new Error(result.error.message);
        }
        return result.ready;
      }});
    if (Number(new URL(ready.url).port || 80) !== installedService.port) throw new Error('HTTP-ready URL port differs from the approved installation port; preserve this installation.');
    completeSetup(plan.releases, saved);
    say(t('server:setup.ready', { port: installedService.port, url: ready.url }));
    request.onReady?.(ready.url);
    return { installed: true, ...(approval.request.application?.current === plan.facts.version ? { operation: 'change' as const } : {}), url: ready.url, port: installedService.port, version: plan.facts.version };
  } catch (cause) {
    if (starting) startFailure(cause, plan.releases, service.definition.name, language, request.onFailure ?? say);
    const guidance = cause instanceof SkillWriteFailure ? t('server:setup.skillWriteFailed') : setupFailureAdvice(cause);
    throw new Error(`${guidance}\nSetup did not complete. Preserve the installation record, data at ${displayInstallationPath(plan.workspace)} and the logged cause. After resolving the reported cause, run setup again to resume the saved request.`, { cause });
  } finally { prepared.unlock(); }
}
/** Commands follow the real adapters: systemd journals; launchd has no stdout/stderr file configured. */
export function serviceStartupAdvice(name: string, language: ServerLocale, host: string = process.platform, failure?: unknown): string {
  const commands = host === 'darwin'
    ? `launchctl print gui/${process.getuid!()}/${name}\nlog show --last 10m --style compact --predicate 'process == "launchd" AND eventMessage CONTAINS "${name}"'`
    : `systemctl --user status ${name}\njournalctl --user -u ${name} -n 50 --no-pager`;
  const stoppedService = failure instanceof ServiceStartRequired ? failure.service : undefined;
  const start = stoppedService ? host === 'darwin' ? `launchctl kickstart gui/${process.getuid!()}/${stoppedService}` : `systemctl --user start ${stoppedService}` : null;
  const t = serverText(language);
  return `${t('server:setup.startup.check')}\n${commands}\n${host === 'darwin' ? t('server:setup.startup.launchdLogs') + '\n' : ''}` +
    (start ? t('server:setup.startup.startSaved', { command: start }) : t('server:setup.startup.rerun'));
}

export async function prepareSetup(request: SetupRequest, approved: SetupPlan, say: (line: string) => void, agentEnvironment?: InspectionEnvironment) {
  const plan = inspectSetup(request);
  if (plan.workspace !== approved.workspace || plan.releases !== approved.releases || plan.existing !== approved.existing ||
      plan.facts.version !== approved.facts.version || plan.facts.source !== approved.facts.source || !equal(plan.installation, approved.installation))
    throw new Problem(PROBLEM_CODE.conflict, 'Setup selection changed after confirmation; inspect and confirm it again');
  if ((!plan.installation?.service) && !readSetupSkills(plan.releases) && plan.existing) await assertWorkspaceStopped(plan.workspace);
  let releases = plan.releases, unlock: (() => void) | undefined;
  try {
    // Public setup reaches write preparation only after its one confirmation.
    assertProductDirectory(releases, userHome(request.env)); mkdirSync(releases, { recursive: true, mode: 0o700 });
    releases = realpathSync(releases);
    let release: string;
    if (request.artifact) {
      release = await request.artifact.publish(releases, say);
      unlock = holdReleases(releases);
    } else {
      unlock = holdReleases(releases);
      release = await publishSelfRelease(releases, { source: plan.facts.source,
        edition: plan.facts.edition, targets: parseTargets(plan.facts.targets.join(',')) }, say);
    }
    assertUpdateHandoff(release,{releases,workspace:plan.workspace});
    new InstallationStore(installationPath(request.env)).prepareDirectory(userHome(request.env), approved.installation);
    const workspaceRequest = { ...request, explicit: plan.workspace };
    if (!plan.existing) await initializeInstallation({ ...workspaceRequest, language: request.language, agentEnvironment });
    const installation = await registerInstallation(workspaceRequest, releases);
    return { release, installation, unlock };
  } catch (cause) {
    unlock?.();
    const reason = cause instanceof Error ? cause.message : String(cause), advice = setupFailureAdvice(cause, releases);
    throw new Error(`${advice}\nSetup preparation did not complete. Releases path: ${releases}; installation record path: ${installationPath(request.env)}. Inspect any created files before retrying.${advice === reason ? '' : `\nReason: ${reason}`}`, { cause });
  }
}

/** Advice adds the next action to the original error, never inventing rollback or backups. */
export function setupFailureAdvice(error: unknown, releases?: string): string {
  const message = error instanceof Error ? error.message : String(error);
  if (releases) {
    if (hasCode(error, 'EACCES') || hasCode(error, 'EPERM') || hasCode(error, 'EROFS'))
      return `Check write permission for releases directory ${releases}, or choose a writable --releases folder, then run setup again.`;
    if (hasCode(error, 'ENOSPC')) return `Free disk space on the filesystem containing ${releases}, then run setup again.`;
    if (hasCode(error, 'ENOENT') || hasCode(error, 'ENOTDIR') || hasCode(error, 'ELOOP'))
      return `Check that releases path ${releases} is a real accessible directory, or choose another --releases folder, then run setup again.`;
    if (/Another release operation is running/.test(message))
      return `Wait for the release operation in ${releases} to finish, then run setup again.`;
  }
  if (/Foreign serve responds|Another serve writer owns|already has a serve writer/.test(message))
    return 'Choose another --workspace. Only stop this server when intentionally converting it to a managed installation, then retry.';
  if (/management facts differ/.test(message))
    return 'Use the recorded HOME and releases path; inspect the installation record before changing them.';
  return message;
}

function importCurrent(releases: string): string | null {
  const current=linkTarget(releases,'current');
  return current ? readPackageVersion(current).version : null;
}
