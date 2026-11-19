import { releasePath } from '../release/edition.js';
/** Local acquisition composes with the existing setup and update Owners. */
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { digestBytes, Problem, PROBLEM_CODE } from '@alpacawork/core';
import { InstalledSkillsStore, bundledSkillSelection } from '@alpacawork/core/installed-skills';
import { readPackageVersion } from '@alpacawork/core/package-version';
import { selectServer } from '@alpacawork/cli-kit';
import { connectionPath, readConnection } from '@alpacawork/contract/connection';
import { serverText } from '@alpacawork/i18n/server';
import { userHome, workspaceArgument } from '../workspace.js';
import { parseDeploySource, pinDeployRepository, commitPackage } from '../release/deploy-source.js';
import { buildRelease } from '../release/build.js';
import { holdReleases, linkTarget, type ReleaseKind } from '../release/layout.js';
import { PACKAGE_TARGETS } from '../release/package-closure.js';
import { acquireNpmCandidate, observeNpmCandidate } from '../release/npm-candidate.js';
import { stable } from '../release/npm-records.js';
import { readUpdateRecord, updateJournal, completedUpdate, controllerAlive } from '../release/update-record.js';
import { acceptPreparedUpdate } from '../release/update-operation.js';
import { launchUpdateController } from '../release/update-controller.js';
import { resolveUpdateRuntime, candidateEnvironment, npmAcquisitionRuntime } from '../release/update-runtime.js';
import { InstallationStore, installationPath } from './store.js';
import { installationSkillsRoot } from './setup.js';
import { confirmInstallation, installationLanguage, type InstallationTerminal } from './confirmation.js';
import { readSetupSkills } from './setup-skills.js';
import { inspectAgentSkillLinks } from './agent-skill-links.js';
import { inspectSetup, installSetup, requestedInstallationService, serviceDescription, type SetupRequest, type SetupArtifact, type InstallationResult } from './public-setup.js';

type DeployRequest = SetupRequest & { source: string; confirm?: string; server?: string; kind?: ReleaseKind };
/** A confirmation binds the destination and both versions, never just a blanket yes. */
export function deployConfirmation(plan: unknown): string { return digestBytes(stable(plan)); }
export function assertDeployConfirmation(plan: unknown, confirmation: string): void {
  if (deployConfirmation(plan) !== confirmation) throw new Problem(PROBLEM_CODE.conflict, 'Deployment plan changed or --confirm does not match. Read the displayed plan and confirm it again');
}
async function destination(request: DeployRequest): Promise<SetupRequest> {
  const record = new InstallationStore(installationPath(request.env)).read();
  if (record || request.explicit !== undefined) return request;
  const selected = await selectServer(request.server, request.env);
  try {
    const response = await fetch(new URL('/api/identity', selected.server), {redirect:'error',signal:AbortSignal.timeout(5000)});
    if (!response.ok) throw new Error('Server identity unavailable');
    const identity = await response.json() as {root: string; generation: string};
    if (typeof identity.root !== 'string' || typeof identity.generation !== 'string') throw new Error('Server identity invalid');
    const root = workspaceArgument(identity.root, request.cwd, userHome(request.env));
    const connection = readConnection(connectionPath(root));
    if (connection.generation !== identity.generation) throw new Error('Connected server is not this local workspace');
    return {...request,explicit:root};
  } catch (cause) {
    if (selected.source !== 'default') throw new Problem(PROBLEM_CODE.invalidInput, 'Cannot resolve the connected local installation; specify --workspace and --releases explicitly', undefined, {cause});
    return request;
  }
}
export async function runDeploy(input: DeployRequest, say: (line: string) => void, terminal?: InstallationTerminal) {
  const request = {...input,...await destination(input)}, home = userHome(request.env);
  const source = parseDeploySource(request.source, request.cwd, home), kind = request.kind ?? 'production';
  let artifact: SetupArtifact;
  // Selection does not write the destination. The initial setup confirmation must precede acquisition there.
  if (source.kind === 'repository') {
    const pinned = pinDeployRepository(source), pkg = commitPackage(pinned.repo, pinned.sha);
    artifact = { facts:{...pkg,source:pinned.sha,edition:kind,targets:[...PACKAGE_TARGETS]},
      publish: async (releases, log) => {const unlock=holdReleases(releases);try{return await buildRelease(pinned.repo, releases, pinned.sha, log, kind);}finally{unlock();}} };
  } else {
    const provisional = inspectSetup({...request, artifact:{facts:{name:source.packageName,version:source.selector,source:'0'.repeat(40),edition:kind,targets:[...PACKAGE_TARGETS]},publish:async()=>{throw new Error('Inspection only');}}});
    const registry = npmAcquisitionRuntime(request.env, source.packageName, source.selector);
    const expectedActive = provisional.installation?.releases ? linkTarget(provisional.releases,'current') : null;
    const observed = await observeNpmCandidate({releases:provisional.releases,candidateId:randomUUID(),expectedActive,registry,environment:candidateEnvironment(kind)});
    if (!observed.ok) throw new Problem(PROBLEM_CODE.unavailable, `npm candidate could not be inspected: ${observed.error.kind}`, undefined, {cause:observed.error.fault});
    const candidate = observed.value;
    artifact = {facts:{name:candidate.packageName,version:candidate.exactVersion,...candidate.facts}, publish:async releases => {
      const acquired = await acquireNpmCandidate({releases,candidate,registry});
      if (!acquired.ok) throw new Problem(PROBLEM_CODE.unavailable, `npm acquisition failed: ${acquired.error.kind}`, undefined, {cause:acquired.error.fault});
      return acquired.value.release;
    }};
  }
  return applyDeployArtifact(request,artifact,say,terminal);
}
export async function applyDeployArtifact(request: SetupRequest & {source?:string;confirm?:string}, artifact:SetupArtifact, say:(line:string)=>void, terminal?:InstallationTerminal): Promise<InstallationResult> {
  const kind=artifact.facts.edition;
  const selection = {...request,artifact}, plan = inspectSetup(selection);
  if (!plan.installation?.service || readSetupSkills(plan.releases)) return installSetup(selection, say, terminal);
  const managed = requestedInstallationService(plan,request);
  const current = linkTarget(plan.releases,'current');
  if (!current) throw new Problem(PROBLEM_CODE.conflict,'Recorded installation has no current release; finish the original setup');
  const receipt = new InstalledSkillsStore(installationSkillsRoot(request.env)).read()?.receipt;
  if (receipt?.state !== 'complete') throw new Problem(PROBLEM_CODE.conflict,'Managed skills are not installed; finish setup first');
  const skills = {root:installationSkillsRoot(request.env),place:bundledSkillSelection(receipt.skills.map(s=>s.name))};
  const target = releasePath(plan.releases,artifact.facts);
  const preview = {workspace:plan.workspace,releases:plan.releases,service:managed.definition.name,
    current:{release:current,version:readPackageVersion(current).version},target:{release:target,version:artifact.facts.version},skills};
  const confirmation = deployConfirmation({...preview,installation:plan.installation}), t = serverText(installationLanguage(request.env));
  const application = {current:preview.current.version,target:preview.target.version};
  say(t('server:deploy.preview',{workspace:plan.workspace,...application,confirmation}));
  if (request.confirm !== undefined) assertDeployConfirmation({...preview,installation:plan.installation},request.confirm);
  else if (!request.yes && (!(terminal?.input??process.stdin).isTTY || !(terminal?.output??process.stdout).isTTY))
    return {installed:false,reason:'confirmation_required',plan:preview,confirm:confirmation};
  else {
    const approved = await confirmInstallation({workspace:plan.workspace,releases:plan.releases,showReleases:request.releases !== undefined,existing:true,
      service:serviceDescription(managed.definition,t),agents:[],application,skills:skills.place.map(name=>({name,destination:join(skills.root,name),action:'replace'})),links:inspectAgentSkillLinks(skills.root,skills.place,[]),
      notes:[t('server:deploy.overwrite.switch')],overwrite:[t('server:deploy.overwrite.noRestore')]},terminal,{yes:request.yes});
    if (!approved.approved) return {installed:false,reason:approved.reason};
  }
  // Builds/publication use the same release lock. Acceptance rechecks current under that lock afterward.
  const release=await artifact.publish(plan.releases,say);
  const facts=readPackageVersion(release),runtime=resolveUpdateRuntime(plan.workspace,request.env);
  const opId=acceptPreparedUpdate(runtime,{kind:'prepared',origin:request.source ?? 'installed package',candidateId:randomUUID(),exactVersion:facts.version,
    edition:facts.edition,facts,expectedActive:current},skills,current,plan.installation);
  // The controller compacts successful operations; keep the accepted identity to read its readiness proof afterward.
  const accepted = readUpdateRecord(plan.releases).operation;
  await launchUpdateController(plan.workspace,opId);
  say(t('server:deploy.accepted',{opId}));
  for (const deadline=performance.now()+300_000;;) {
    const state=readUpdateRecord(plan.releases),op=state.operation;
    if (op?.opId===opId) {
      const journal=updateJournal(plan.releases,op), result=completedUpdate(plan.releases,op,journal);
      if(result==='committed') return {installed:true,opId,workspace:plan.workspace,release,version:facts.version,...journal?.ready};
      if(result || op.failure&&!controllerAlive(op)) throw new Problem(PROBLEM_CODE.unavailable,op.failure?.cause??`Deployment did not commit: ${result}`,{opId,log:join(plan.releases,'.updates/controller.log')});
    } else if (state.lastResult?.opId===opId&&state.lastResult.result==='committed') {
      const journal = accepted?.opId === opId ? updateJournal(plan.releases, accepted) : null;
      return {installed:true,opId,workspace:plan.workspace,release,version:facts.version,...journal?.ready};
    }
    else throw new Problem(PROBLEM_CODE.conflict,'Deployment operation was replaced; inspect its saved result',{opId});
    if(performance.now()>=deadline)throw new Problem(PROBLEM_CODE.unavailable,'Deployment is still pending; inspect the saved operation and retry the same target',{opId});
    await delay(500);
  }
}
