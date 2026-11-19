/** Application adapter. Installation/service registration remains entirely owned by installation. */
import { Problem, PROBLEM_CODE } from '@alpacawork/core';
import { InstallationStore, installationPath } from '../installation/store.js';
import { readInstallationService, installationSkillsRoot } from '../installation/setup.js';
import { dirname, join } from 'node:path';
import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { thisRelease } from './location.js';
import { readManifest, type PackageTarget } from './package-closure.js';
import { releaseKind } from './edition.js';
import type { NpmMetadataRequest } from './npm-registry.js';
import type { CandidateEnvironment } from './npm-records.js';
import type { SwitchPlace } from './switch.js';
import { readUpdateRecord } from './update-record.js';
import { loadJournal } from './journal.js';
export type UpdateRuntime = { place: SwitchPlace; registry: NpmMetadataRequest; environment: CandidateEnvironment;
  writer: { root: string } };
/** Null means an unmanaged source installation, never a damaged managed installation. Read-only. */
export function updateRuntime(workspace: string, env:NodeJS.ProcessEnv=process.env): UpdateRuntime | null {
 const running=thisRelease();
 const record=new InstallationStore(installationPath(env)).read();
 // Installation facts, not the location of a global launcher or target continuation, own the destination.
 const release=record?.releases ? join(record.releases, 'current') : running;
 if(!release)return null;
 if(!record&&!env.ALPACAWORK_MANAGED_RELEASES&&!readUpdateRecord(dirname(release)).operation&&
   loadJournal({releases:dirname(release),workspace})===null)return null;
 if(!record||!record.releases||!record.service)throw new Problem(PROBLEM_CODE.conflict,'The managed update does not match the installation record. Leave the records as they are and check the state of the installation.',
  {reason:'installation_record_missing'},{reason:{kind:'update_refused',reason:'installation_record_missing'}});
 let selected:ReturnType<typeof readInstallationService>;
 try{selected=readInstallationService({workspace,releases:dirname(release),env});}
 catch(cause){if(cause instanceof Problem)throw cause;const io=!!cause&&typeof cause==='object'&&'code'in cause,reason=io?'installation_service_unavailable':'installation_service_mismatch';
  throw new Problem(io?PROBLEM_CODE.unavailable:PROBLEM_CODE.conflict,'The installation record cannot be verified. Leave the records as they are and follow the guidance of setup.',{reason},{cause,reason:{kind:'update_refused',reason}});}
 const {installation,definition}=selected;
 return {place:{workspace:installation.workspace,releases:installation.releases,service:definition.name,say:line=>console.error(line)},
  get registry() { return npmAcquisitionRuntime(env, readManifest(release).name); },
  environment:candidateEnvironment(releaseKind(release)),writer:{root:installationSkillsRoot(env)}};
}
/** npm is needed only by the npm producer, never by repository deployment. */
export function candidateEnvironment(edition: import('./edition.js').ReleaseKind): CandidateEnvironment {
 let target:PackageTarget;
 if(process.platform==='linux'&&process.arch==='x64'&&(process.report.getReport() as {header:{glibcVersionRuntime?:string}}).header.glibcVersionRuntime)target='linux-x64-glibc';
 else if(process.platform==='darwin'&&process.arch==='arm64')target='darwin-arm64';
 else throw new Problem(PROBLEM_CODE.unsupportedPlatform,'This installation has no supported release target',undefined,
  {reason:{kind:'installation_release_target_unsupported'}});
 return {managedNodeVersion:process.version,target,edition};
}
export function npmAcquisitionRuntime(env: NodeJS.ProcessEnv, packageName: string, selector = 'latest'): NpmMetadataRequest {
 const nodeExecutable=realpathSync(process.execPath), home=env.HOME!;
 let npmCli:string;
 try{npmCli=realpathSync(join(dirname(nodeExecutable),'npm'));if(!statSync(npmCli).isFile())throw new Error('The Node installation has no regular npm launcher');accessSync(npmCli,constants.R_OK);}
 catch(cause){throw new Problem(PROBLEM_CODE.unavailable,'The Node installation has no readable npm launcher',{reason:'installation_npm_unavailable'},{cause,reason:{kind:'update_refused',reason:'installation_npm_unavailable'}});}
 return {nodeExecutable,npmCli,packageName,selector,
  userConfig:env.npm_config_userconfig??join(home,'.npmrc'),globalConfig:env.npm_config_globalconfig??join(dirname(dirname(nodeExecutable)),'etc/npmrc'),
  homeDirectory:home,environment:{...env,HOME:home,PATH:[dirname(nodeExecutable),env.PATH??'/usr/bin:/bin'].join(':')}};
}
/** Explicit update commands require management; ordinary startup/discovery/status may have none. */
export function resolveUpdateRuntime(workspace: string, env:NodeJS.ProcessEnv=process.env): UpdateRuntime {
 const runtime=updateRuntime(workspace,env);
 if(!runtime)throw new Problem(PROBLEM_CODE.conflict,'There is no installation record. Install from a terminal with alpacawork deploy <from>.',
  {reason:'not_managed'},{reason:{kind:'update_refused',reason:'not_managed'}});
 return runtime;
}
