import { backendEntry } from '../app-paths.js';
import { createHash } from 'node:crypto';
import { verifyRecoveryGrant,frozenRecovery } from './maintenance-authorization.js';
import type { RecoveryGrant } from './journal.js';
import { spawnSync } from 'node:child_process';
/** Release build, inspection, retention and explicit recovery commands. */
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { codecs, defineEntry, defineEntryEndpoint, defineEntryNode, defineParameter, optional } from '@alpacakit/channels';
import { bindCliOptions } from '@alpacawork/cli-kit';
import { PROBLEM_CODE, Problem, parseInput } from '@alpacawork/core';
import { z } from 'zod';
import { requireLocal, requireRoot, type Context } from '../entries.js';
import { buildRelease } from './build.js';
import { packRelease } from './package.js';
import { packageName, packageVersion, parseTargets, PACKAGE_TARGETS } from './package-closure.js';
import { holdReleases } from './layout.js';
import { prune, status, switchTo, recoverBackup } from './switch.js';


const parameter = (name: string, description: string, fallback?: string) => defineParameter({ name, description,
  codec: codecs.string(), requirement: fallback === undefined ? optional() : optional({ default: fallback }) });
const releasesParameter = parameter('releases', 'Releases directory', '~/.local/share/alpacawork/releases');
const serviceParameter = parameter('service', 'systemd user unit, or launchd label on macOS, that runs serve', 'alpacawork.service');
const refParameter = parameter('ref', 'Commit of the repository to release', 'main');
const repoParameter = parameter('repo', 'Repository to build from (default: the working directory)');
const kindParameter = parameter('kind', 'Build edition: production or diagnostic', 'production');
const operationParameter = parameter('op-id', 'Operation ID to inspect in the frozen failed-side group');
const backupParameter = parameter('backup', 'Absolute DB backup group directory to recover');
const keepParameter = parameter('keep', 'Newest releases prune keeps besides current and previous', '0');
const nameParameter = parameter('name', 'Explicit fixture or approved distribution package name');
const versionParameter = parameter('version', 'npm version to publish instead of the commit package.json version (pre-releases)');
const outputParameter = parameter('output', 'Directory for local tarballs and retained failed assembly evidence');
const targetsParameter = parameter('targets', 'Required native closures, comma-separated; WSL2 uses Linux bytes', PACKAGE_TARGETS.join(','));

const input = z.object({ releases: z.string(), service: z.string().optional(), ref: z.string().optional(),
  repo: z.string().optional(), backup:z.string().optional(), 'op-id':z.string().optional(), kind: z.enum(['production', 'diagnostic']).optional(), keep: z.string().regex(/^\d+$/).transform(Number).optional(),
  name: z.string().optional(), version: z.string().optional(), output: z.string().optional(), targets: z.string().optional() });
type WorkValues=z.infer<typeof input>&{releases:string;recoveryGrant?:RecoveryGrant};
const say = (line: string) => console.error(`release: ${line}`);

/**
 * Each operation is a person's, or a Task responsible's Run ('release', decided on its own Task in the workspace it
 * serves), and holds the releases directory's lock for its whole length.
 */
async function withReleases<T>(context: Context, raw: unknown, operation: (values: WorkValues) => Promise<T> | T) {
  const values = parseInput(input, raw);
  const asked = resolve(values.releases.replace(/^~(?=\/|$)/, homedir()));
  const releases = existsSync(asked)?realpathSync(asked):asked;
  const frozen=values.backup&&context.cli?.env.ALPACAWORK_RUN?frozenRecovery(requireRoot(context),resolve(values.backup)):null;
  let recoveryGrant:RecoveryGrant|undefined;
  if(frozen?.authorization) {verifyRecoveryGrant(requireRoot(context),frozen.authorization,context.cli!.env);recoveryGrant=frozen.authorization;}
  else if(frozen) {
    // Read-only authorization before creating directories or acquiring a release lock.
    const checked=spawnSync(process.execPath,[backendEntry('maintenance', frozen.reader),
      'recovery-authorize',requireRoot(context),frozen.failure],{encoding:'utf8',timeout:30_000,env:{...context.cli!.env}});
    if(checked.error||checked.signal)throw new Problem(PROBLEM_CODE.unavailable,'Recovery maintenance authorization could not complete',
      {code:(checked.error as NodeJS.ErrnoException|undefined)?.code,signal:checked.signal});
    if(checked.status!==0)throw new Problem(PROBLEM_CODE.forbidden,'Recovery maintenance authorization refused',{stderr:checked.stderr});
  }else {
    const caller=requireLocal(context,{name:'release'},()=>requireRoot(context));
    if(caller.kind==='run')recoveryGrant={caller,tokenDigest:createHash('sha256').update(context.cli!.env.ALPACAWORK_RUN_TOKEN!).digest('hex')};
  }
  mkdirSync(asked, { recursive: true });
  const release = holdReleases(releases);
  try {
    if(frozen&&frozenRecovery(requireRoot(context),resolve(values.backup!))?.id!==frozen.id)throw new Problem(PROBLEM_CODE.conflict,'Recovery changed during authorization');
    return await operation({ ...values, releases,recoveryGrant });
  } finally { release(); }

}
const repoOf = (context: Context, repo: string | undefined) => resolve(context.cli?.cwd ?? process.cwd(), repo ?? '.');
const place = (context: Context, values: { releases: string; service?: string }) =>
  ({ releases: values.releases, workspace: requireRoot(context), service: values.service!, say });

function command(name: string, description: string, parameters: ReturnType<typeof parameter>[],
  handler: (values: WorkValues, context: Context) => unknown) {
  const entry = defineEntry({ name, parameters, project: ({ values }) => values });
  return defineEntryNode({ name, description, endpoints: [defineEntryEndpoint(entry, {
    handler: (raw: unknown, context: Context) => withReleases(context, raw, values => handler(values, context)),
    channels: [bindCliOptions(entry.parameters)],
  })] });
}

export const releaseNode = defineEntryNode({ name: 'release', description: 'Build, inspect and recover installed releases', children: [
  command('build', 'Build --ref into the releases directory without switching',
    [releasesParameter, refParameter, repoParameter, kindParameter], async (values, context) =>
      ({ release: await buildRelease(repoOf(context, values.repo), values.releases, values.ref!, say, values.kind) })),
  command('pack', 'Build --ref and assemble a local offline npm tarball without installing or switching',
    [releasesParameter, refParameter, repoParameter, kindParameter, nameParameter, versionParameter, outputParameter, targetsParameter], async (values, context) => {
      if (!values.name || !values.output) throw new Problem(PROBLEM_CODE.invalidInput, 'release pack requires explicit --name and --output');
      let targets: ReturnType<typeof parseTargets>;
      try {
        packageName(values.name);
        if (values.version !== undefined) packageVersion(values.version);
        targets = parseTargets(values.targets!);
      }
      catch (error) {
        throw new Problem(PROBLEM_CODE.invalidInput, error instanceof Error ? error.message : String(error), undefined, { cause: error });
      }
      return packRelease({ repo: repoOf(context, values.repo), releases: values.releases, ref: values.ref!, kind: values.kind,
        name: values.name, ...(values.version === undefined ? {} : { version: values.version }), output: resolve(context.cli?.cwd ?? process.cwd(), values.output), targets, say });
    }),
  command('rollback', 'Switch serve back to the previous release', [releasesParameter, serviceParameter], (values, context) =>
    switchTo(place(context, values), { link: 'previous' })),
  command('recover', 'Restore a complete T0 DB group; preserve later IDs and diagnose retained files',
    [releasesParameter, serviceParameter, backupParameter], (values,context)=>{
      if(!values.backup)throw new Problem(PROBLEM_CODE.invalidInput,'--backup is required');
      return recoverBackup(place(context,values),values.backup,undefined,values.recoveryGrant);
    }),
  command('operation', 'Inspect one pre-restore operation with its version-matched maintenance reader',
    [releasesParameter, backupParameter, operationParameter], (values,context)=>{
      const recovery=values.backup?frozenRecovery(requireRoot(context),resolve(values.backup)):null;
      if(!recovery||!values['op-id'])throw new Problem(PROBLEM_CODE.invalidInput,'Admitted --backup and --op-id are required');
      const found=spawnSync(process.execPath,[backendEntry('maintenance', recovery.reader),'recovery-operation',
        requireRoot(context),recovery.failure,values['op-id']],{encoding:'utf8',timeout:30_000,maxBuffer:Infinity,env:{...context.cli?.env}});
      if(found.error||found.signal)throw new Problem(PROBLEM_CODE.unavailable,'Failed-side operation inspection could not complete',
        {code:(found.error as NodeJS.ErrnoException|undefined)?.code,signal:found.signal});
      if(found.status!==0)throw new Problem(PROBLEM_CODE.forbidden,'Failed-side operation inspection refused',{stderr:found.stderr});
      return JSON.parse(found.stdout);
    }),

  command('prune', 'Remove releases that no process runs', [releasesParameter, keepParameter],
    (values, context) => ({ removed: prune(values.releases, values.keep!, say, requireRoot(context)) })),
  command('status', 'Show current, previous and the processes running each release', [releasesParameter],
    values => status(values.releases)),
] });
