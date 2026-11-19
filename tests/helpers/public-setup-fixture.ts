import { installSetupSystemctl } from './setup-systemctl.ts';
import { assembleFixtureDistribution } from './distribution-fixture.ts';
import { backendUnitLibrary } from './backend-unit-library.ts';
import assert from 'node:assert/strict';
import { after, before, type TestContext } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomInt } from 'node:crypto';
import { createServer, type Server } from 'node:net';
import { appendFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createOriginal, copyWorkspace, removeWorkspace, profiles } from '../../scripts/dev-fixtures/fixture.ts';
import { cleanCliEnv, httpStatus } from './http-cli.ts';
import { preserveTestFailure } from './failure-workspace.ts';
import { ControlStore } from '@alpacawork/db';
import { completeSkillsReceiptSchema } from '@alpacawork/core/installed-skills';

import { stubBundledStatus } from './agent-inspection.ts';

/** Each test file owns its distribution, original, state, and before/after hooks. */
export function publicSetupSuite() {
  let suite: string, image: string, original: string, library: string;
  let sourceBefore: ReturnType<typeof snapshot>, originalBefore: ReturnType<typeof snapshot>;
  let evidenceFile: string | undefined;
  const evidence = (value: unknown) => { if (evidenceFile) appendFileSync(evidenceFile, JSON.stringify({ suite, pid: process.pid, at: new Date().toISOString(), ...value as object }) + '\n'); };
  const snapshot = (root: string) => ['.', ...readdirSync(root, { recursive: true, encoding: 'utf8' }).sort()].map(name => { const path = join(root, name), info = lstatSync(path); return { name, mode: info.mode, hash: info.isFile() ? hash(path) : info.isSymbolicLink() ? readlinkSync(path) : null }; });
  let owner: typeof import('@alpacawork/backend/test-dist/installation/public-setup.js');
  const hash = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
  before(async () => {
    suite = mkdtempSync(join(tmpdir(), 'public-setup-'));
    evidenceFile = process.env.PUBLIC_SETUP_EVIDENCE ? process.env.PUBLIC_SETUP_EVIDENCE+'.'+basename(suite)+'.jsonl' : undefined;
    const source=spawnSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).stdout.trim();
    image=join(suite,'image');assembleFixtureDistribution(resolve('.'),join(suite,'built'),image,source,stubBundledStatus);
    const bundles=readdirSync(resolve('apps/backend/dist'),{recursive:true,encoding:'utf8'}).filter(f=>f.endsWith('.js')).sort();
    const generated=bundles.map(file=>({file,built:hash(resolve('apps/backend/dist',file)),image:hash(join(image,'apps/backend/dist',file))}));
    for(const file of generated)assert.equal(file.built,file.image,file.file);
    evidence({kind:'source-image-correspondence',source,generated});
    library=backendUnitLibrary(resolve('.'),join(suite,'unit-library'),image);
    owner=await import(pathToFileURL(join(library,'installation/public-setup.js')).href);
    original = createOriginal({ ...profiles.small, seed: 'public-setup' }, join(suite, 'cache')).root;
    sourceBefore = snapshot(image); originalBefore = snapshot(original);
    evidence({ kind: 'suite-ready', image, original, library });
  });
  after(() => { if (image && sourceBefore) { assert.deepEqual(snapshot(image), sourceBefore, 'self package source stays unchanged'); assert.deepEqual(snapshot(original), originalBefore, 'synthetic original stays unchanged'); evidence({ kind: 'source-preservation', imageFiles: sourceBefore.length, originalFiles: originalBefore.length, unchanged: true }); } if (original && existsSync(original)) removeWorkspace(original); if (suite) rmSync(suite, { recursive: true, force: true }); evidence({ kind: 'suite-cleanup', removed: !suite || !existsSync(suite) }); });
  function fixture(t: TestContext, homeName = 'home') {
    const root = mkdtempSync(join(suite, 'case-')), home = join(root, homeName); mkdirSync(home);
    const env = cleanCliEnv({ HOME: home, PATH: join(root, 'empty-bin'), XDG_CONFIG_HOME: join(home, '.config') }); delete env.SUDO_USER; delete env.SUDO_UID;
    const cleanup: (() => unknown)[] = [];
    t.after(async () => {
      const errors: unknown[] = [];
      const preserve = (error?: unknown) => preserveTestFailure(t, root, {
        databaseRoot: existsSync(join(home, 'alpacawork/.alpacawork/alpacawork.sqlite')) ? join(home, 'alpacawork') : root,
        ...(error === undefined ? {} : { failure: { error } }),
      });
      try {
        for (const close of cleanup) try { await close(); }
        catch (error) {
          errors.push(error);
          // after-hook errors are not yet reflected in t.error. Capture before the next cleanup releases resources.
          try { await preserve(error); } catch (captureError) { errors.push(captureError); }
        }
        try { await preserve(); } catch (error) { errors.push(error); }
      } finally {
        rmSync(root, { recursive: true, force: true });
        evidence({ kind: 'case-cleanup', test: t.name, root, removed: !existsSync(root) });
      }
      if (errors.length) throw new AggregateError(errors, 'Public setup fixture cleanup failed');
    });
    evidence({ kind: 'case-ready', test: t.name, root, home });
    return { root, home, env, cleanup, request: { cwd: root, env }, releases: join(home, '.local/share/alpacawork/releases') };
  }
  function publicFixture(t: TestContext, homeName = 'home') {
    const f = fixture(t, homeName), bin = join(f.root, 'bin'); mkdirSync(bin, { mode: 0o700 });
    const systemctl = join(bin, 'systemctl'); installSetupSystemctl(systemctl);
    writeFileSync(join(bin, 'gh'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
    const checks = join(f.root, 'agent-checks.jsonl');
    writeFileSync(join(bin, 'codex'), `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(checks)},JSON.stringify(process.argv.slice(2))+'\\n');process.exit(99);\n`, { mode: 0o700 });
    writeFileSync(join(bin, 'journalctl'), '#!/bin/sh\nprintf \"Fake service log\\n\"\n', { mode: 0o700 });
    const env: NodeJS.ProcessEnv = { ...f.env, PATH: `${bin}:/usr/bin:/bin`, LANG: 'en', LC_ALL: 'en_US.UTF-8', XDG_DATA_HOME: join(f.home, '.local/share'),
      XDG_STATE_HOME: join(f.home, '.local/state'), XDG_CACHE_HOME: join(f.home, '.cache') };
    // The same process owns HTTP clients: it must keep handling socket close/data while the manager waits for exit.
    const native = (...args: string[]) => new Promise<{ status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((done, reject) => {
      const child = spawn(systemctl, ['--user', ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      child.stdout.on('data', bytes => stdout += bytes); child.stderr.on('data', bytes => stderr += bytes);
      child.once('error', reject); child.once('close', (status, signal) => done({ status, signal, stdout, stderr }));
    });
    let stopped: Awaited<ReturnType<typeof native>> | undefined;
    f.cleanup.push(async () => {
      rmSync(join(f.home, 'manager-unavailable'), { force: true });
      stopped = await native('stop', 'alpacawork.service');
      evidence({ kind: 'service-cleanup', test: t.name, home: f.home, ...stopped });
      assert.equal(stopped.status, 0, stopped.stderr);
    });
    // Emergency reclamation is separate from stop success: its failure above still fails the test and is captured first.
    f.cleanup.push(async () => {
      if (stopped?.status === 0) return;
      const killed = await native('kill', 'alpacawork.service');
      assert.equal(killed.status, 0, killed.stderr);
    });
    let portPreload: string | undefined;
    /** A saved setup port must stay out of other fixtures' automatic TCP allocation until service start.
     * This Linux systemd fixture leases a port below that range; an abstract socket owns its identity
     * across test workers, and disappears even if the worker dies. The real backend still binds the saved port.
     */
    async function reserveServicePort() {
      assert.equal(portPreload, undefined);
      const firstEphemeral = Number(readFileSync('/proc/sys/net/ipv4/ip_local_port_range', 'utf8').trim().split(/\s+/)[0]);
      const lower = 10000, upper = Math.min(firstEphemeral, 32768);
      assert(upper > lower, 'a dedicated service port range must exist below automatic TCP allocation');
      const listen = (server: Server, options: { path: string } | { port: number; host: string }) => new Promise<void>((done, reject) => {
        server.once('error', reject); server.listen(options, done);
      });
      const close = (server: Server) => new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
      const first = randomInt(lower, upper);
      for (let offset = 0; offset < upper - lower; offset++) {
        const port = lower + (first - lower + offset) % (upper - lower), lease = createServer(), probe = createServer();
        try { await listen(lease, { path: `\0alpacawork-setup-test-${process.getuid!()}-${port}` }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') continue; throw error; }
        lease.unref();
        try { await listen(probe, { port, host: '127.0.0.1' }); }
        catch (error) { await close(lease); if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') continue; throw error; }
        await close(probe);
        f.cleanup.unshift(() => close(lease));
        portPreload = join(f.root, 'service-port.mjs');
        // Only the CLI's initial OS port selection uses the leased candidate. No saved record or backend is patched.
        writeFileSync(portPreload, `import { Server } from 'node:net';
const listen = Server.prototype.listen;
Server.prototype.listen = function(options, ...rest) {
  return Reflect.apply(listen, this, [options?.port === 0 && options.host === '127.0.0.1' ? { ...options, port: ${port} } : options, ...rest]);
};\n`);
        evidence({ kind: 'dedicated-service-port', test: t.name, port, firstEphemeral });
        return port;
      }
      throw new Error('No dedicated setup service port is available');
    }
    let invocation = 0;
    async function run(answer: string | string[] = 'enter', args: string[] = [], preload?: string, diagnose = false) {
      if (args[0] === 'setup' && !args.includes('--no-open')) args = [...args, '--no-open'];
      const config = join(f.root, `pty-${++invocation}.json`), output = join(f.root, `pty-${invocation}-result.json`);
      const pidPath = join(f.home, 'fake-manager/pid.json'); let running = false;
      if (existsSync(pidPath)) { const saved = JSON.parse(readFileSync(pidPath, 'utf8')); try { const fields = readFileSync(`/proc/${saved.pid}/stat`, 'utf8').split(') ')[1]!.split(' '); running = fields[0] !== 'Z' && fields[19] === saved.start; } catch {} }
      // Runtime DBs, Run output, backend stdout and periodic update discovery.
      // The no-CLI baseline and backend child traces establish these writers; release distributions remain protected.
      // All other HOME files, especially record/unit/skills/release/request/ack, remain protected.
      const runtimeOwnedPaths = running ? ['alpacawork/.alpacawork/alpacawork.sqlite', 'alpacawork/.alpacawork/host.sqlite'].flatMap(path => ['', '-wal', '-shm'].map(suffix => path + suffix)).concat(['fake-manager/backend.log']) : [];
      // The live backend publishes registry observations independently of the setup CLI.
      const updateRoots = running ? [relative(f.home, join(f.releases, '.updates'))] : [];
      const runtimeOwnedRoots = running ? ['alpacawork/.alpacawork/runs', ...updateRoots] : [];
      const runtimeOwnedPublications = running ? ['alpacawork/.alpacawork/execution-identity.json'] : [];
      const command = [process.execPath, ...[portPreload, preload].flatMap(file => file ? ['--import', file] : []), join(image, 'bin/alpacawork.mjs'), ...args];
      writeFileSync(config, JSON.stringify({ home: f.home, cwd: f.root, env, output, answer, runtimeOwnedPaths, runtimeOwnedRoots, runtimeOwnedPublications, baselineSeconds: diagnose ? 35 : 0, trace: diagnose || runtimeOwnedPublications.length ? { prefix: join(f.root, `cli-trace-${invocation}`), paths: [...updateRoots, ...(diagnose ? [...runtimeOwnedPaths, ...runtimeOwnedRoots] : [])] } : undefined,
        umask: 0o002, command }));
      const child = spawn(process.execPath, [resolve('tests/helpers/setup-terminal.ts'), config], { stdio: ['ignore', 'pipe', 'pipe'], env });
      let stdout = '', stderr = ''; child.stdout.on('data', data => stdout += data); child.stderr.on('data', data => stderr += data);
      const status = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
      assert.equal(status, 0, stderr + stdout);
      const result = JSON.parse(stdout) as { status: number; transcript: string; prompt: boolean; confirmations: number; unchangedBeforeEnter: boolean | null; protectedChanges: unknown[]; cliBeforeEnterWrites: unknown[]; runtimePublicationChanges: { path: string }[]; beforeEnterChanges: unknown[]; baselineChanges: unknown[]; promptTime: number; runtimeOwnedPaths: string[] };
      evidence({ kind: 'public-pty', test: t.name, args, ...result });
      if (result.prompt) { if (!running) assert.equal(result.unchangedBeforeEnter, true, JSON.stringify(result.beforeEnterChanges)); assert.deepEqual(result.protectedChanges, [], 'setup-owned HOME bytes/modes must be unchanged before Enter'); assert.deepEqual(result.cliBeforeEnterWrites, [], 'The CLI must not write runtime observations before Enter'); }
      evidence({ kind: 'cli-before-enter-runtime-write-audit', test: t.name, writableBeforeEnter: result.cliBeforeEnterWrites, promptTime: result.promptTime });
      if (diagnose && process.env.PUBLIC_SETUP_EVIDENCE) { const dest = evidenceFile+'.traces'; mkdirSync(dest, { recursive: true }); for (const name of readdirSync(f.root)) if (name.startsWith('backend-trace') || name.startsWith('cli-trace-')) cpSync(join(f.root, name), join(dest, name)); }
      let payload = result.transcript.split(/\r?\n/).reverse().flatMap(line => {
        try { const value = JSON.parse(line); return value && typeof value.installed === 'boolean' ? [value as { installed: boolean; url?: string; version?: string; port?: number }] : []; } catch { return []; }
      })[0];
      // Interactive setup prints a human URL instead of a machine result. The fixture observes that URL;
      // ready() separately checks HTTP identity and the installed version/receipt.
      if (args[0] === 'setup' && result.status === 0) {
        const url = result.transcript.match(/(?:Open:?|開く:|ブラウザで開きます →|Opening in your browser →) (http:\/\/127\.0\.0\.1:\d+\/)/)?.[1];
        payload = url ? { installed: true, url, port: Number(new URL(url).port) } : { installed: false };
      }
      return { ...result, payload };
    }
    const journal = () => existsSync(join(f.releases, 'setup-skills.json')) ? JSON.parse(readFileSync(join(f.releases, 'setup-skills.json'), 'utf8')) : null;
    const receipt = () => completeSkillsReceiptSchema.parse(JSON.parse(readFileSync(join(f.home, '.agents/skills/.alpacawork/installed.json'), 'utf8')));
    const ready = async (out: Awaited<ReturnType<typeof run>>, workspace = join(f.home, 'alpacawork')) => {
      assert.equal(out.status, 0, out.transcript); const payload = out.payload; assert(payload, out.transcript);
      assert.equal(payload.installed, true, out.transcript);
      const expectedVersion = JSON.parse(readFileSync(join(image, 'package.json'), 'utf8')).version;
      if (payload.version !== undefined) assert.equal(payload.version, expectedVersion);
      const url = payload.url; assert(url, out.transcript);
      const response = await fetch(new URL('/api/runtime/readiness', url), { headers: { Connection: 'close' } }), body = await response.json();
      assert.equal(response.status, 200); assert.equal(body.workspace, workspace); assert.equal(body.state, 'accepting');
      assert.equal(journal(), null, 'HTTP-ready setup has no pending request');
      const saved = receipt();
      assert.equal(saved.request.release, realpathSync(join(f.releases, 'current')));
      for (const name of saved.request.place) assert.equal(saved.skills.find(skill => skill.name === name)?.source.version, expectedVersion);
      assert.deepEqual(readdirSync(join(f.home, '.agents/skills/.alpacawork')).sort(), ['install.lock', 'installed.json']);
      assert.equal(JSON.parse(readFileSync(join(f.releases, 'switch.json'), 'utf8')).phase, 'committed');
      const setup = await import(pathToFileURL(join(library,'installation/setup.js')).href);
      const service = setup.readInstallationService({ workspace, releases: f.releases, env });
      assert.equal(service.installation.version, 4); assert.equal(service.definition.name, 'alpacawork.service');
      assert.equal(payload.port, service.port); assert(service.port > 0 && service.port <= 65535);
      assert.equal(Number(new URL(url).port || 80), service.port); assert.equal(service.definition.args.at(-1), String(service.port));
      // A readiness probe owns its complete response and never leaves a pooled client for service cleanup.
      assert.equal(await httpStatus(url, { headers: { Connection: 'close' } }), 200);
      const { systemdDefinition } = await import('../../packages/core/dist/platform/systemd-service.js');
      const native = systemdDefinition(service.definition); assert.equal(readFileSync(native.path, 'utf8'), native.text);
      evidence({ kind: 'public-ready', test: t.name, saved, readiness: body, service });
      return { saved, body };
    };
    return { ...f, bin, checks, env, run, ready, native, journal, receipt, reserveServicePort };
  }
  /** Keep stored fixture data while leaving no seed work for the live backend to dispatch. */
  function copySetupWorkspace(destination: string) {
    copyWorkspace(original, destination);
    const control = new ControlStore(destination);
    try { control.write(db => db.prepare("UPDATE placements SET ended_at='2026-09-25T00:00:00.000Z'").run()); }
    finally { control.close(); }
    evidence({ kind: 'inert-setup-copy', destination });
  }
  return { fixture, publicFixture, hash, evidence, copySetupWorkspace, get owner() { return owner; }, get image() { return image; }, get original() { return original; }, get library() { return library; } };
}
