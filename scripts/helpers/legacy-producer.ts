/** Test/diagnostic-only bootstrap of an exact historical producer. Never used by product release callers. */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { packageEnvironment } from '@alpacawork/backend/test-dist/release/package-facts.js';
export async function buildHistoricalRelease(options: {
  repo: string; releases: string; producerRef: string; targetRef: string; workRoot: string;
}): Promise<string> {
  const repo = resolve(options.repo), releases = resolve(options.releases), env = packageEnvironment();
  mkdirSync(options.workRoot, { recursive: true }); mkdirSync(releases, { recursive: true });
  const work = mkdtempSync(join(options.workRoot, 'legacy-producer-'));
  async function step(command: string, args: string[]) {
    const child = spawn(command, args, { cwd: work, env, stdio: ['ignore', 2, 2] });
    await new Promise<void>((done, fail) => {
      let error: Error | undefined; child.on('error', value => { error = value; });
      child.on('close', code => code === 0 && !error ? done() : fail(new Error(`Historical producer ${command} failed: ${error?.message ?? code}`, { cause: error })));
    });
  }
  try {
    const archive = spawnSync('git', ['-C', repo, 'archive', options.producerRef], { maxBuffer: 64 * 1024 * 1024 });
    if (archive.status !== 0 || archive.error) throw new Error(`Historical archive failed: ${archive.error?.message ?? archive.stderr}`);
    const unpack = spawnSync('tar', ['-x', '-C', work], { input: archive.stdout });
    if (unpack.status !== 0 || unpack.error) throw new Error(`Historical extract failed: ${unpack.error?.message ?? unpack.stderr}`);
    const sha = spawnSync('git', ['-C', repo, 'rev-parse', `${options.producerRef}^{commit}`], { encoding: 'utf8' }).stdout.trim();
    writeFileSync(join(work, 'SOURCE'), sha + '\n');
    await step('pnpm', ['install', '--offline', '--frozen-lockfile', '--ignore-scripts', '--package-import-method=copy']);
    // Historical build scripts may predate queue integration. The current queue owns admission for this bootstrap.
    await step(process.execPath, [join(repo, 'scripts/testing/queue.ts'), 'build', '--', 'pnpm', 'build']);
    const entry = pathToFileURL(join(work, 'apps/backend/dist/release/build.js')).href;
    const script = `import {buildRelease} from ${JSON.stringify(entry)};const release=await buildRelease(...JSON.parse(process.argv[1]),line=>console.error(line));console.log(JSON.stringify({release}));`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, JSON.stringify([repo, releases, options.targetRef])], {
      cwd: work, env, stdio: ['ignore', 'pipe', 2],
    });
    let output = ''; child.stdout!.on('data', value => { output += value; });
    await new Promise<void>((done, fail) => {
      let error: Error | undefined; child.on('error', value => { error = value; });
      child.on('close', code => code === 0 && !error ? done() : fail(new Error(`Historical buildRelease failed: ${error?.message ?? code}`, { cause: error })));
    });
    const release = JSON.parse(output).release;
    if (typeof release !== 'string') throw new Error('Historical producer returned no release');
    rmSync(work, { recursive: true, force: true }); return release;
  } catch (error) { throw new Error(`Historical producer failed; evidence retained at ${work}`, { cause: error }); }
}
