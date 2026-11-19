import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { after, test, type TestContext } from 'node:test';
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync,
  readdirSync, symlinkSync, unlinkSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';
import { observeNpmCandidate as observeActual, stageConfirmedNpmCandidate as stageActual } from '../apps/backend/test-dist/release/npm-candidate.js';
import type { CandidateResult, NpmCandidate, HumanConfirmedNpmCandidate } from '../apps/backend/src/release/npm-candidate.ts';
const observeNpmCandidate: typeof import('../apps/backend/src/release/npm-candidate.ts').observeNpmCandidate = observeActual;
const stageConfirmedNpmCandidate: typeof import('../apps/backend/src/release/npm-candidate.ts').stageConfirmedNpmCandidate = stageActual;
import { downloadNpmTarball } from '../apps/backend/test-dist/release/npm-download.js';
import { extractNpmArchive } from '../apps/backend/test-dist/release/npm-archive.js';
import { validateRelease } from '../apps/backend/test-dist/release/edition.js';
import { readUpdateRecord, saveUpdateRecord } from '../apps/backend/test-dist/release/update-record.js';
import { holdReleases } from '../apps/backend/test-dist/release/layout.js';
import { prune } from '../apps/backend/test-dist/release/switch.js';
import { inventory } from '../apps/backend/test-dist/release/package-files.js';
import type { NpmMetadataRequest } from '../apps/backend/src/release/npm-registry.ts';

const manifest = JSON.parse(readFileSync(process.env.ALPACAWORK_NPM_CANDIDATE_MANIFEST ?? new URL('./fixtures/npm-candidate-manifest.json', import.meta.url), 'utf8'));
const npmCli = resolve(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js');
const events: unknown[] = [];
function saveEvidence() { if (process.env.ALPACAWORK_NPM_CANDIDATE_EVIDENCE) writeFileSync(process.env.ALPACAWORK_NPM_CANDIDATE_EVIDENCE,
  JSON.stringify({ node: process.version, pid: process.pid, events }, null, 2)); }
after(saveEvidence);
const success = <T>(result: CandidateResult<T>): T => { if (result.ok === false) throw Error(JSON.stringify(result)); return result.value; };
function failure(result: CandidateResult<unknown>, kind: string) { assert.equal(result.ok, false, JSON.stringify(result)); if (result.ok) throw Error('unreachable'); assert.equal(result.error.kind, kind); }
/** A stopped npm's pipes get 250 ms to close: on a starved machine that bound truthfully says cleanup_failed instead. */
function stopped(result: CandidateResult<unknown>, kind: string) { assert.equal(result.ok, false, JSON.stringify(result)); if (result.ok) throw Error('unreachable'); assert(result.error.kind === kind || result.error.kind === 'cleanup_failed', JSON.stringify(result)); }
const sri = (bytes: Uint8Array) => 'sha512-' + createHash('sha512').update(bytes).digest('base64');
async function fixture(t: TestContext, body: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>, bytes?: Buffer) {
  const f = await setup(t, bytes); try { await body(f); } finally { await f.close(); }
}
async function setup(t: TestContext, payload: Buffer = Buffer.from('raw fixed bytes, deliberately not an archive')) {
  const root = mkdtempSync(join(tmpdir(), 'npm-candidate-')), releases = join(root, 'releases');
  for (const name of ['releases', 'home', 'temp']) mkdirSync(join(root, name));
  let latest = manifest.version, mode = 'normal', tarMode = 'normal', metadata: Record<string, unknown>;
  const requests: { path: string; auth: boolean }[] = [];
  const server = createServer((req, res) => {
    requests.push({ path: req.url!, auth: !!req.headers.authorization });
    if (req.url === '/artifact.tgz' || req.url === '/redirect.tgz') {
      if (tarMode === 'auth') { res.writeHead(401); res.end('SECRET /private/path'); return; }
      if (tarMode === 'timeout') return;
      if (req.url === '/redirect.tgz') { res.writeHead(302, { location: '/artifact.tgz' }); res.end(); return; }
      if (tarMode === 'partial') { res.writeHead(200, { 'content-length': payload.length + 100 }); res.write(payload.subarray(0, 10)); res.socket?.destroy(); return; }
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(tarMode === 'wrong' ? Buffer.from('different bytes') : payload); return;
    }
    if (mode === 'auth') { res.writeHead(401); res.end('{"error":"SECRET"}'); return; }
    if (mode === 'timeout') return;
    if (mode === 'yank') { res.writeHead(404); res.end('{}'); return; }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ name: manifest.name, 'dist-tags': { latest }, time: { modified: latest }, versions: {
      [manifest.version]: { ...metadata, ...(mode === 'missing' ? { alpacawork: undefined } : {}),
        ...(mode === 'unknown' ? { alpacawork: { future: true } } : {}),
        ...(mode === 'replaced' ? { description: 'replaced metadata' } : {}), ...(mode === 'deprecated' ? { deprecated: 'withdrawn' } : {}) },
      '0.4.0': { ...metadata, version: '0.4.0' },
      '0.10.0': { ...metadata, version: '0.10.0' },
    } }));
  });
  const lifetime = setTimeout(() => { server.closeAllConnections(); server.close(); }, 120000);
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); assert(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  metadata = { ...structuredClone(manifest), description: 'Synthetic localhost distribution metadata',
    dist: { tarball: origin + '/artifact.tgz', integrity: sri(payload) } };
  writeFileSync(join(root, 'user.npmrc'), `registry=${origin}/\n//127.0.0.1:${address.port}/:_authToken=SECRET\n`);
  writeFileSync(join(root, 'global.npmrc'), '');
  const registry: NpmMetadataRequest = { nodeExecutable: process.execPath, npmCli, packageName: manifest.name,
    selector: 'latest', userConfig: join(root, 'user.npmrc'), globalConfig: join(root, 'global.npmrc'), homeDirectory: join(root, 'home'),
    temporaryDirectory: join(root, 'temp'), environment: { PATH: '/usr/bin:/bin' }, deadlineMs: 5000, fetchTimeoutMs: 600 };
  const environment = { managedNodeVersion: process.version, target: 'linux-x64-glibc' as const, edition: 'production' as const };
  const observe = (candidateId = 'candidate-1', expectedActive: string | null = null) => observeNpmCandidate({ releases, candidateId, expectedActive, registry, environment });
  const defaultOperation = randomUUID(), operationIds = new Map<string,string>();
  // This fixture is the synthetic internal human boundary; production acquisition cannot bootstrap authority.
  const confirm = (candidate: NpmCandidate, alias: string = defaultOperation): HumanConfirmedNpmCandidate => {
    if(!operationIds.has(alias))operationIds.set(alias,randomUUID());const opId=operationIds.get(alias)!;
    const unlock=holdReleases(releases);
    try{const state=readUpdateRecord(releases);
      if(state.operation?.opId!==opId){const digest='d'.repeat(64);
        state.operation={opId,workspace:root,candidate,reviewDigest:digest,phase:'fetching',controller:null,failure:null,
          skills:{root:join(root,'skills'),place:['alpacawork']}};
        saveUpdateRecord(releases,state);}
    }finally{unlock();}
    return {candidateId:candidate.candidateId,metadataDigest:candidate.metadataDigest,expectedActive:candidate.expectedActive,opId};
  };
  const stage = (confirmation: HumanConfirmedNpmCandidate, extra = {}) => stageConfirmedNpmCandidate({ releases, confirmation, registry, ...extra });
  const tarRequests = () => requests.filter(r => r.path.endsWith('.tgz')).length;
  const checkClean = () => { assert.deepEqual(readdirSync(join(root, 'temp')), []); assert.equal(readdirSync(releases).filter(n => n.startsWith('.npm-stage-')).length, 0); };
  const ownedFixtures: string[] = [];
  let closed = false;
  return { ownFixture: (path: string) => ownedFixtures.push(path), root, releases, registry, environment, observe, confirm, stage, requests, tarRequests, checkClean,
    mode: (value: string) => { mode = value; }, tarMode: (value: string) => { tarMode = value; },
    latest: (version: string) => { latest = version; }, metadata: () => metadata,
    close: async () => { if (closed) return; closed = true; clearTimeout(lifetime); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));
      events.push({ test: t.name, requests, stageEntries: readdirSync(releases).filter(n => n.startsWith('.npm-stage-')) });
      checkClean();
      for (const path of ownedFixtures.reverse()) execFileSync(process.execPath, [resolve('scripts/dev-fixtures/fixture.ts'), 'remove', '--root', path],
        { env: { HOME: join(root, 'home'), PATH: dirname(process.execPath) + ':/usr/bin:/bin' }, timeout: 30000 });
      rmSync(root, { recursive: true, force: true }); },
  };
}

test('candidate observation reads fixed product facts without saving UUID records or fetching a tarball', async t => fixture(t, async f => {
  const first = success(await f.observe()); assert.equal(first.facts.source, manifest.alpacawork.source); assert.equal(first.changes, 'unknown');
  assert.equal('cliContract' in first.facts, false, 'acquisition accepts product facts without redundant CLI hashes');
  assert.equal('migrations' in first.facts.schema.control, false, 'acquisition accepts DB reader/history facts without a legacy migration declaration');
  assert.deepEqual(success(await f.observe()), first); assert.equal(f.tarRequests(), 0);
  assert.equal(existsSync(join(f.releases, 'current')), false);
  f.latest('0.4.0'); assert.equal(success(await f.observe()).exactVersion,'0.4.0');
  assert.equal(existsSync(join(f.releases,'.npm-candidates')),false);
  f.latest(manifest.version);
  for (const mode of ['missing', 'unknown']) { f.mode(mode); failure(await f.observe('new'), 'metadata_unknown'); }
  f.mode('deprecated'); failure(await f.observe('new'), 'candidate_withdrawn'); assert.equal(f.tarRequests(), 0);
}));

test('confirmation requires exact digest/active and same operation input; no network download on mismatch/yank/replacement', async t => fixture(t, async f => {
  const candidate = success(await f.observe()), confirmation = f.confirm(candidate);
  failure(await f.stage({ ...confirmation, metadataDigest: 'a'.repeat(64) }), 'confirmation_mismatch');
  symlinkSync('changed', join(f.releases, 'current')); failure(await f.stage(confirmation), 'expected_active_changed'); unlinkSync(join(f.releases, 'current'));
  f.mode('replaced'); failure(await f.stage(confirmation), 'metadata_changed');
  f.mode('normal');
  const original = structuredClone(f.metadata());
  for (const replacement of [
    { alpacawork: { ...manifest.alpacawork, source: 'f'.repeat(40) } },
    { dist: { ...(original.dist as object), integrity: sri(Buffer.from('changed version integrity')) } },
    { dist: { ...(original.dist as object), tarball: candidate.registryOrigin + '/changed.tgz' } },
    { fixtureRevision: 'a real version metadata change' },
  ]) {
    Object.assign(f.metadata(), replacement);
    failure(await f.stage(confirmation), 'metadata_changed');
    for (const key of Object.keys(f.metadata())) delete f.metadata()[key];
    Object.assign(f.metadata(), structuredClone(original));
  }
  f.mode('yank'); failure(await f.stage(confirmation), 'metadata_failed');
  f.mode('normal'); const other = success(await f.observe('candidate-2'));
  failure(await f.stage(f.confirm(other)), 'confirmation_mismatch'); assert.equal(f.tarRequests(), 0);
}));

test('raw acquisition through managed npm verifies fixed bytes before any archive interpretation, including scoped auth and redirect', async t => fixture(t, async f => {
  const candidate = success(await f.observe());
  for (const redirect of [false, true]) {
    const root = join(f.root, randomUUID()); mkdirSync(root);
    const result = await downloadNpmTarball(f.registry, { ...candidate, tarball: candidate.registryOrigin + (redirect ? '/redirect.tgz' : '/artifact.tgz') }, root, new AbortController().signal, 1024 * 1024);
    assert.equal(result.ok, true, JSON.stringify(result));
    if (result.ok) assert.equal(sri(readFileSync(result.file)), candidate.integrity);
  }
  assert(f.requests.filter(r => r.path.endsWith('.tgz')).every(r => r.auth));
  failure(await f.stage(f.confirm(candidate)), 'archive_invalid');
}));

test('fixed SRI mismatch, auth rejection, partial transfer, deadline and cancellation stop with bounded cleanup', async t => fixture(t, async f => {
  const candidate = success(await f.observe());
  for (const mode of ['wrong', 'auth', 'partial']) {
    f.tarMode(mode); const result = await f.stage(f.confirm(candidate)); failure(result, mode === 'wrong' ? 'integrity_mismatch' : 'download_failed');
    assert(!JSON.stringify(result).includes('SECRET')); f.checkClean();
  }
  f.tarMode('timeout'); let start = Date.now(); stopped(await f.stage(f.confirm(candidate), { deadlineMs: 900 }), 'deadline');
  assert(Date.now() - start < 2200); f.checkClean();
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort('SECRET'), 500);
  try { start = Date.now(); stopped(await f.stage(f.confirm(candidate), { signal: controller.signal }), 'aborted'); assert(Date.now() - start < 2000); }
  finally { clearTimeout(timer); }
}));

/** Minimal ustar fixture; tests observe extractor's actual output and preserve a guard-removal counterexample. */
function tar(members: { name: string; type?: string; data?: string; link?: string }[]) {
  const chunks: Buffer[] = [];
  for (const m of members) {
    const header = Buffer.alloc(512), data = Buffer.from(m.data ?? ''); header.write(m.name);
    const number = (at: number, width: number, n: number) => header.write(n.toString(8).padStart(width - 1, '0') + '\0', at, width);
    number(100, 8, 0o644); number(108, 8, 0); number(116, 8, 0); number(124, 12, data.length); number(136, 12, 0);
    header.fill(32, 148, 156); header.write(m.type ?? '0', 156); if (m.link) header.write(m.link, 157);
    header.write('ustar\0', 257); header.write('00', 263); number(148, 8, header.reduce((sum, x) => sum + x, 0));
    chunks.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]));
}
test('archive paths, links, special types, duplicates, parent collisions, corruption and expansion are refused before member writes', async t => {
  const root = mkdtempSync(join(tmpdir(), 'npm-archive-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const invalid = [
    [{ name: 'package/../../escaped', data: 'x' }], [{ name: '/absolute' }], [{ name: 'package/a', type: '2', link: '../../escaped' }],
    [{ name: 'package/a', type: '1', link: 'package/b' }], [{ name: 'package/a', type: '6' }],
    [{ name: 'package/a' }, { name: 'package/a' }], [{ name: 'package/a' }, { name: 'package/a/b' }],
  ];
  for (const [i, members] of invalid.entries()) {
    const stage = join(root, String(i)); mkdirSync(stage); const file = join(stage, 'input.tgz'); writeFileSync(file, tar(members));
    await assert.rejects(extractNpmArchive(file, stage, { maxExpandedBytes: 1024 * 1024, maxEntries: 100, signal: new AbortController().signal }));
    assert.equal(existsSync(join(stage, 'unpacked')), false);
  }
  const file = join(root, 'expanded.tgz'); writeFileSync(file, tar([{ name: 'package/a', data: 'x'.repeat(10000) }]));
  await assert.rejects(extractNpmArchive(file, root, { maxExpandedBytes: 1024, maxEntries: 100, signal: new AbortController().signal }));
  assert.equal(existsSync(join(root, 'unpacked')), false);
});

const acceptedTarball = process.env.ALPACAWORK_NPM_CANDIDATE_TARBALL;
function archiveChecksum(raw: Buffer) {
  const header = raw.subarray(0, 512); header.fill(32, 148, 156);
  header.write(header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(7, '0') + '\0', 148, 8);
}
test('every ustar numeric field rejects lossy bytes, missing terminators and non-padding suffixes before member writes', async t => {
  const root = mkdtempSync(join(tmpdir(), 'npm-archive-numbers-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const original = gunzipSync(tar([{ name: 'package/item' }])); let count = 0;
  for (const at of [329, 337]) original.write('0000000\0', at, 8);
  archiveChecksum(original);
  const input = (raw: Buffer) => {
    const stage = join(root, String(count++)); mkdirSync(stage);
    const file = join(stage, 'input.tgz'); writeFileSync(file, gzipSync(raw));
    return { stage, extract: () => extractNpmArchive(file, stage, { maxExpandedBytes: 1024 * 1024, maxEntries: 100, signal: new AbortController().signal }) };
  };
  const fields = [['mode', 100, 8, false], ['uid', 108, 8, true], ['gid', 116, 8, true], ['size', 124, 12, false],
    ['mtime', 136, 12, true], ['checksum', 148, 8, false], ['devmajor', 329, 8, true], ['devminor', 337, 8, true]] as const;
  const observed: string[] = [];
  for (const [name, at, width, optional] of fields) {
    const corruptions: [string, (field: Buffer) => void][] = [
      ['high-first', field => { field[0] = field[0]! | 0x80; }],
      ['high-middle', field => { const i = Math.floor(field.length / 2); field[i] = field[i]! | 0x80; }],
      ['high-terminator', field => { field[field.length - 1] = 0x80; }],
      ['non-octal', field => { field[0] = 56; }], ['sign', field => { field[0] = 45; }],
      ['tab', field => { field[0] = 9; }],
      ['suffix', field => { const digits = Number.parseInt(field.toString('latin1'), 8).toString(8); field.fill(0); field.write(digits + '\0' + '7'); }],
      ['unterminated', field => { const n = Number.parseInt(field.toString('latin1'), 8); field.write(n.toString(8).padStart(field.length, '0')); }],
    ];
    if (!optional) corruptions.push(['empty-required', field => { field.fill(0); }]);
    for (const [label, corrupt] of corruptions) {
      const raw = Buffer.from(original), field = raw.subarray(at, at + width);
      // Checksum bytes are excluded from their own sum; other mutations need a valid new checksum.
      corrupt(field); if (at !== 148) archiveChecksum(raw);
      const f = input(raw); await assert.rejects(f.extract(), /archive_number/);
      assert.equal(existsSync(join(f.stage, 'unpacked')), false); assert.equal(existsSync(join(f.stage, 'expanded.tar')), false);
      observed.push(name + ':' + label);
    }
    if (optional) for (const byte of [0, 32]) {
      const raw = Buffer.from(original); raw.fill(byte, at, at + width); archiveChecksum(raw);
      const f = input(raw); assert.equal(fs.statSync(join(await f.extract(), 'item')).size, 0);
    }
  }
  // Preserve ordinary octal with leading spaces and both NUL/space padding.
  const padded = Buffer.from(original);
  for (const [, at, width] of fields) {
    if (at === 148) continue;
    const digits = Number.parseInt(padded.subarray(at, at + width).toString('latin1'), 8).toString(8);
    padded.write(' '.repeat(width - digits.length - 2) + digits + '\0 ', at, width);
  }
  archiveChecksum(padded); const normal = input(padded); assert.equal(fs.statSync(join(await normal.extract(), 'item')).size, 0);
  for (let at = 257; at < 263; at++) {
    const raw = Buffer.from(original); raw[at] = raw[at]! | 0x80; archiveChecksum(raw);
    const f = input(raw); await assert.rejects(f.extract(), /archive_header/); assert.equal(existsSync(join(f.stage, 'unpacked')), false);
  }
  events.push({ numericByteMatrix: { fields: fields.map(f => f[0]), refused: observed, acceptedEmptyOptional: 10, paddedOctal: true, highBitMagicRefused: 6 } });
});

test('the concealed-header numeric counterexample and high-bit magic break the same rejection checks when byte protection is removed', async t => {
  const root = mkdtempSync(join(tmpdir(), 'npm-archive-counterexample-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const hidden = gunzipSync(tar([{ name: 'package/hidden-link', type: '2', link: 'placeholder' }])).subarray(0, 512);
  const raw = gunzipSync(tar([{ name: 'package/numeric-pad', data: hidden.toString('utf8') },
    { name: 'package/package.json', data: JSON.stringify({ name: 'numeric-boundary-fixture', version: '1.0.0' }) }]));
  raw[129] = raw[129]! | 0x80; archiveChecksum(raw);
  assert.equal(raw.subarray(124, 136).toString('hex'), '3030303030b0303130303000');
  const badMagic = gunzipSync(tar([{ name: 'package/item' }])); badMagic[257] = badMagic[257]! | 0x80; archiveChecksum(badMagic);
  const production = resolve('apps/backend/test-dist/release/npm-archive.js'), source = readFileSync(production, 'utf8');
  const start = source.indexOf('const numeric = '), end = source.indexOf('const text = ', start);
  assert(start >= 0 && end > start);
  const legacy = `const numeric = (field, optional = false) => {
    const value = field.toString('ascii').replace(/\\0.*$/, '').trim();
    if (optional && !value) return 0;
    if (!/^[0-7]+$/.test(value)) throw new Error('archive_number');
    return Number.parseInt(value, 8);
  };\n`;
  const magic = "header.subarray(257, 263).toString('latin1')"; assert(source.includes(magic));
  const file = join(dirname(production), `npm-archive-lossy-${process.pid}.js`); t.after(() => rmSync(file, { force: true }));
  writeFileSync(file, (source.slice(0, start) + legacy + source.slice(end)).replace(magic, "header.subarray(257, 263).toString('ascii')"));
  const mutated = await import(pathToFileURL(file).href) as typeof import('../apps/backend/src/release/npm-archive.ts');
  for (const [name, bytes, pattern] of [['numeric', raw, /archive_number/], ['magic', badMagic, /archive_header/]] as const) {
    const input = join(root, name + '.tgz'); writeFileSync(input, gzipSync(bytes));
    const stage = join(root, name), mutantStage = join(root, name + '-mutated'); mkdirSync(stage); mkdirSync(mutantStage);
    const options = { maxExpandedBytes: 1024 * 1024, maxEntries: 100, signal: new AbortController().signal };
    const rejectsInput = (subject: Promise<string>) => assert.rejects(subject, pattern);
    await rejectsInput(extractNpmArchive(input, stage, options)); assert.equal(existsSync(join(stage, 'unpacked')), false);
    let accepted: string | undefined;
    await assert.rejects(rejectsInput(mutated.extractNpmArchive(input, mutantStage, options).then(path => { accepted = path; return path; })), assert.AssertionError);
    assert(accepted);
    events.push({ archiveByteGuardRemoved: { name, sameRejectionAssertionBroken: true, accepted: true,
      ...(name === 'numeric' && { customPadBytes: fs.statSync(join(accepted, 'numeric-pad')).size,
        hiddenLinkWritten: existsSync(join(accepted, 'hidden-link')) }) } }); saveEvidence();
  }
});

test('accepted Linux product: metadata → human internal confirmation → exact bytes → immutable release; latest move/replay/collision',
  { skip: !acceptedTarball, timeout: 120000 }, async t => fixture(t, async f => {
    // Shared synthetic small fixture, ordinary independent copy, never production data.
    const fixtureScript = resolve('scripts/dev-fixtures/fixture.ts');
    const environment = { HOME: join(f.root, 'home'), PATH: dirname(process.execPath) + ':/usr/bin:/bin' };
    const made = JSON.parse(execFileSync(process.execPath, [fixtureScript, 'create', '--profile', 'small', '--seed', 'npm-candidate',
      '--cache', join(f.root, 'fixture-cache')], { env: environment, encoding: 'utf8', timeout: 30000 }));
    f.ownFixture(made.root);
    const workspace = join(f.root, 'workspace');
    execFileSync(process.execPath, [fixtureScript, 'copy', '--source', made.root, '--dest', workspace], { env: environment, timeout: 30000 });
    f.ownFixture(workspace);
    const protectedBefore = inventory(workspace);
    const before = f.tarRequests(), candidate = success(await f.observe()); assert.equal(f.tarRequests(), before);
    assert.equal(existsSync(join(f.releases,'.npm-candidates/candidate-1.json')),false);
    const production = resolve('apps/backend/test-dist/release/npm-candidate.js');
    const source = readFileSync(production, 'utf8'), marker = '_contentLength: _responseLength, ';
    assert(source.includes(marker));
    const file = join(dirname(production), `npm-candidate-length-${process.pid}.js`);
    t.after(() => rmSync(file, { force: true }));
    writeFileSync(file, source.replace(marker, ''));
    const mutated = await import(pathToFileURL(file).href) as typeof import('../apps/backend/src/release/npm-candidate.ts');
    const mutantCandidate = success(await mutated.observeNpmCandidate({ releases: f.releases, candidateId: 'length-mutant',
      expectedActive: null, registry: f.registry, environment: f.environment }));
    const { fetchNpmMetadata } = await import('../apps/backend/test-dist/release/npm-registry.js');
    const oldResponse = await fetchNpmMetadata({ ...f.registry, selector: candidate.exactVersion }); assert(oldResponse.ok);
    // This tag names an existing version and changes the HTTP response length, unlike 0.4.0.
    f.latest('0.10.0');
    const newResponse = await fetchNpmMetadata({ ...f.registry, selector: candidate.exactVersion }); assert(newResponse.ok);
    assert.notEqual(oldResponse.metadata._contentLength, newResponse.metadata._contentLength);
    const mutantResult = await mutated.stageConfirmedNpmCandidate({ releases: f.releases, registry: f.registry,
      confirmation: f.confirm(mutantCandidate, 'length-mutant-op') });
    const counterexample = { oldLength: oldResponse.metadata._contentLength, newLength: newResponse.metadata._contentLength,
      mutantResult, tarballs: f.tarRequests(), sameSuccessAssertionBroken: false };
    events.push({ responseLengthGuard: counterexample }); saveEvidence();
    failure(mutantResult, 'metadata_changed');
    const accepts = (result: { ok: boolean }) => assert.equal(result.ok, true, JSON.stringify(result));
    assert.throws(() => accepts(mutantResult), assert.AssertionError);
    counterexample.sameSuccessAssertionBroken = true; saveEvidence();
    assert.equal(f.tarRequests(), before);
    const stagedResult = await f.stage(f.confirm(candidate)); accepts(stagedResult);
    const staged = success(stagedResult);
    assert.equal(existsSync(join(f.releases,'.npm-candidates/candidate-1.json')),false);
    assert.equal(staged.candidate.exactVersion, '0.3.0'); assert.equal(staged.sha256, createHash('sha256').update(readFileSync(acceptedTarball!)).digest('hex'));
    assert.equal(validateRelease(f.releases, staged.release), 'production'); assert.deepEqual(staged.candidate.facts, manifest.alpacawork);
    assert.equal(existsSync(join(f.releases, 'current')), false); f.checkClean();
    assert.deepEqual(prune(f.releases, 0, () => {}), []); assert(existsSync(staged.release));
    const afterFirst = f.tarRequests();
    assert.equal(success(await f.stage(f.confirm(candidate))).release, staged.release); assert.equal(f.tarRequests(), afterFirst);
    f.latest(manifest.version);
    f.metadata().alpacawork = { ...manifest.alpacawork, targets: manifest.alpacawork.targets.includes('darwin-arm64') ? ['linux-x64-glibc'] : ['linux-x64-glibc', 'darwin-arm64'] };
    const targetsChanged = success(await f.observe('targets-changed'));
    failure(await f.stage(f.confirm(targetsChanged, 'op-targets')), 'stage_conflict');
    f.metadata().alpacawork = structuredClone(manifest.alpacawork);
    (f.metadata().dist as Record<string, unknown>).integrity = sri(Buffer.from('same source different bytes'));
    const bytesChanged = success(await f.observe('bytes-changed'));
    assert.equal(success(await f.stage(f.confirm(bytesChanged, 'op-bytes'))).release, staged.release);
    (f.metadata().dist as Record<string, unknown>).integrity = candidate.integrity;
    assert.equal(f.tarRequests(), afterFirst);
    writeFileSync(join(staged.release, 'SOURCE'), 'a'.repeat(40)); failure(await f.stage(f.confirm(candidate)), 'stage_conflict');
    assert.deepEqual(inventory(workspace), protectedBefore);
    events.push({ test: t.name, protectedFiles: Object.keys(protectedBefore).length, fixtureRuns: 7, source: candidate.facts.source, sha256: staged.sha256, bytes: staged.bytes, files: Object.keys(inventory(staged.release)).length, currentChanged: false, latestMoved: true });
  }, readFileSync(acceptedTarball!)));


test('removing exact metadata guard falsifies the same rejection through the actual staging boundary', async t => fixture(t, async f => {
  const production = resolve('apps/backend/test-dist/release/npm-candidate.js');
  const source = readFileSync(production, 'utf8');
  const marker = "if (!isDeepStrictEqual(current, candidate))"; assert(source.includes(marker));
  const file = join(dirname(production), `npm-candidate-guard-${process.pid}.js`);
  try {
    writeFileSync(file, source.replace(marker, 'if (false)'));
    const mutated = await import(pathToFileURL(file).href);
    const candidate = success(await f.observe()), confirmation = f.confirm(candidate); f.mode('replaced');
    failure(await f.stage(confirmation), 'metadata_changed'); assert.equal(f.tarRequests(), 0);
    const result = await mutated.stageConfirmedNpmCandidate({ releases: f.releases, confirmation, registry: f.registry });
    assert.throws(() => failure(result, 'metadata_changed'), /archive_invalid/);
    assert.equal(f.tarRequests(), 1);
    events.push({ guard: 'exact metadata equality', normal: 'metadata_changed', mutated: result.error.kind, tarballRequestsAfterRemoval: f.tarRequests() });
  } finally { rmSync(file, { force: true }); }
}));


test('download adapter file cap and escaped pipe holders are bounded without claiming descendant cleanup', {timeout: 15000}, async t => fixture(t, async f => {
  const candidate = success(await f.observe());
  const script = join(f.root, 'fake-npm.cjs'), pidFile = join(f.root, 'pids.json');
  writeFileSync(script, `setTimeout(()=>process.exit(124),10000);const fs=require('node:fs'),cp=require('node:child_process');
    const child=cp.spawn(process.execPath,['-e','setTimeout(()=>process.exit(124),10000);setInterval(()=>{},1000)'],{detached:true,stdio:['ignore',1,2]});
    fs.writeFileSync(${JSON.stringify(pidFile)},JSON.stringify([process.pid,child.pid]));child.unref();process.stdout.write('{}');process.exit(0);`);
  const output = join(f.root, 'escaped-download'); mkdirSync(output);
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 600);
  let ids: number[] = [];
  try {
    const start = Date.now();
    const result = await downloadNpmTarball({...f.registry, npmCli: script}, candidate, output, controller.signal, 1024*1024);
    ids = JSON.parse(readFileSync(pidFile, 'utf8')); assert.equal(result.ok, false);
    if (result.ok === false) assert.equal(result.kind, 'cleanup_failed');
    assert(Date.now() - start < 1500); process.kill(ids[1]!, 0);
    events.push({ downloadEscapedPipe: { result, elapsedMs: Date.now()-start, ids, escapedAliveBeforeHarnessCleanup: true } });
  } finally {
    clearTimeout(timer);
    if (!ids.length && existsSync(pidFile)) ids = JSON.parse(readFileSync(pidFile, 'utf8'));
    for (const pid of ids) try { process.kill(pid, 'SIGKILL'); } catch {}
  }
  const capped = join(f.root, 'capped-download'); mkdirSync(capped);
  // The actual managed npm writes into a file-limited process, rather than an unbounded parent polling race.
  const result = await downloadNpmTarball(f.registry, candidate, capped, new AbortController().signal, 1024);
  assert.equal(result.ok, false);
}, Buffer.alloc(4096, 120)));

test('candidate deadline preserves cleanup_failed when an escaped npm pipe cannot be proven stopped', { timeout: 12000 }, async t => {
  // Exercise the real deadline/pipe timers after the fault is ready, without spending
  // two whole deadlines inside one wall-clock test budget (including real npm setup).
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const phase of ['metadata', 'download']) await fixture(t, async f => {
    const candidate = success(await f.observe()), pidFile = join(f.root, 'deadline-pids.json'), script = join(f.root, 'deadline-npm.cjs');
    writeFileSync(script, `setTimeout(()=>process.exit(124),10000);const fs=require('node:fs'),cp=require('node:child_process'),args=process.argv.slice(2);
      if(${JSON.stringify(phase)}==='metadata'?args.includes('view'):args.includes('noproxy')){
        const child=cp.spawn(process.execPath,['-e','setTimeout(()=>process.exit(124),10000);setInterval(()=>{},1000)'],{detached:true,stdio:['ignore',1,2]});
        fs.writeFileSync(${JSON.stringify(pidFile + '.tmp')},JSON.stringify([process.pid,child.pid]));
        fs.renameSync(${JSON.stringify(pidFile + '.tmp')},${JSON.stringify(pidFile)});child.unref();setInterval(()=>{},1000);
      }else{const r=cp.spawnSync(process.execPath,[${JSON.stringify(npmCli)},...args],{encoding:'utf8',maxBuffer:8*1024*1024});
        process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');process.exit(r.status??1);}`);
    let ids: number[] = [];
    const watcher = fs.watch(f.root);
    try {
      const start = Date.now();
      const staging = stageConfirmedNpmCandidate({ releases: f.releases, confirmation: f.confirm(candidate),
        registry: { ...f.registry, npmCli: script }, deadlineMs: 3000, signal: t.signal });
      // Atomic publication means the escaped process exists and its complete PID list
      // is available before the deadline is fired. Cancellation also ends this wait.
      while (!existsSync(pidFile)) await once(watcher, 'change', { signal: t.signal });
      t.mock.timers.tick(3000);
      t.mock.timers.tick(250);
      const result = await staging;
      ids = JSON.parse(readFileSync(pidFile, 'utf8'));
      failure(result, 'cleanup_failed'); assert(Date.now() - start < 4500); f.checkClean(); process.kill(ids[1]!, 0);
      assert.equal(f.tarRequests(), 0);
      events.push({ deadlineWithEscapedPipe: { phase, result, elapsedMs: Date.now()-start, ids, escapedAliveBeforeHarnessCleanup: true } });
    } finally {
      watcher.close();
      if (!ids.length && existsSync(pidFile)) ids = JSON.parse(readFileSync(pidFile, 'utf8'));
      for (const pid of ids) try { process.kill(pid, 'SIGKILL'); } catch {}
    }
  });
});


// Completion includes synchronous cleanup even when the timer/event callback has not run.
test('stage completion observes cleanup deadline/abort and preserves cleanup_failed priority', {timeout: 15000}, async t => {
  for (const stop of ['deadline', 'aborted'] as const) for (const cleanupFails of [false, true]) {
    await fixture(t, async f => {
      const candidate = success(await f.observe()), controller = new AbortController();
      const original = fs.rmSync, now = Date.now; let reached = false, residual: string | undefined;
      fs.rmSync = (path, options) => {
        if (String(path).startsWith(f.releases + '/.npm-stage-')) {
          reached = true; residual = String(path);
          if (stop === 'deadline') Date.now = () => now() + 300200; else controller.abort('SECRET');
          if (cleanupFails) throw new Error('SECRET cleanup failure');
        }
        return original(path, options);
      };
      syncBuiltinESMExports();
      try {
        const result = await f.stage(f.confirm(candidate), {signal: controller.signal});
        Date.now = now;
        events.push({completionCleanup: {stop, cleanupFails, reached, result,
          residualStage: residual !== undefined && existsSync(residual), current: existsSync(join(f.releases,'current'))}});
        saveEvidence(); // Preserve the actual result before assertion/fixture teardown.
        assert(reached); failure(result, cleanupFails ? 'cleanup_failed' : stop);
        assert.equal(existsSync(join(f.releases,'current')),false);
        assert.equal(existsSync(residual!),cleanupFails);
        assert(!JSON.stringify(result).includes('SECRET'));
      } finally {
        fs.rmSync = original; Date.now = now; syncBuiltinESMExports();
        // Fixture cleanup is distinct from the product's deliberately failed cleanup.
        if(residual) original(residual,{recursive:true,force:true});
      }
    });
  }
});

test('schema metadata delegates control reader/history validation to DB without a legacy migration declaration', async t => fixture(t, async f => {
  const production = resolve('apps/backend/test-dist/release/npm-candidate.js'), source = readFileSync(production, 'utf8');
  const recordsFile = resolve('apps/backend/test-dist/release/npm-records.js'), recordsSource = readFileSync(recordsFile, 'utf8');
  const marker = 'export const schemaFacts =', end = 'export function stable';
  assert(recordsSource.includes(marker) && recordsSource.includes(end));
  const file = join(dirname(production), `npm-candidate-schema-${process.pid}.js`);
  const mutatedRecords = join(dirname(production), `npm-records-schema-${process.pid}.js`);
  const original = structuredClone(f.metadata().alpacawork) as Record<string, unknown>;
  const { controlSchemaManifest } = await import('@alpacawork/db');
  const current = controlSchemaManifest();
  const currentControl = { version: current.version, history: current.history };
  f.metadata().alpacawork = { ...original, schema: { ...manifest.alpacawork.schema, control: currentControl } };
  success(await f.observe('current-schema'));
  try {
    // Schema validation belongs to the record codec Owner and is used both on metadata and persisted facts.
    writeFileSync(mutatedRecords, recordsSource.slice(0, recordsSource.indexOf(marker)) + 'export const schemaFacts = z.unknown();\n' + recordsSource.slice(recordsSource.indexOf(end)));
    writeFileSync(file, source.replace("'./npm-records.js'", JSON.stringify('./' + mutatedRecords.split('/').pop())));
    const mutated = await import(pathToFileURL(file).href);
    for (const schema of [
      { ...manifest.alpacawork.schema, control: { ...currentControl, version: '16' } },
      { ...manifest.alpacawork.schema, control: { ...currentControl, history: 'invalid' } },
      { ...manifest.alpacawork.schema, host: [{ name: 'baseline', hash: 'bad' }] },
      { ...manifest.alpacawork.schema, control: { ...currentControl, history: undefined } },
      { ...manifest.alpacawork.schema, control: { ...currentControl, history: [{ name: 'unknown', hash: 'a'.repeat(64) }] } },
      { ...manifest.alpacawork.schema, host: [{ ...manifest.alpacawork.schema.host[0], unexpected: true }] },
    ]) {
      f.metadata().alpacawork = { ...original, schema };
      failure(await f.observe('schema'), 'metadata_unknown');
      const accepted = await mutated.observeNpmCandidate({ releases: f.releases, candidateId: randomUUID(), expectedActive: null,
        registry: f.registry, environment: f.environment });
      assert.equal(accepted.ok, true, JSON.stringify(accepted));
      events.push({ schemaGuard: { normal: 'metadata_unknown', mutatedAccepted: accepted.ok, tarballs: f.tarRequests() } });
    }
    assert.equal(f.tarRequests(), 0);
  } finally { rmSync(file, {force: true}); rmSync(mutatedRecords, {force: true}); }
}));

test('managed npm cleanup uses the platform process-group Owner and reports signal faults', {timeout: 10000}, async t => fixture(t, async f => {
  const { platform } = await import('@alpacawork/core');
  const { runNpmProcess } = await import('../apps/backend/test-dist/release/npm-process.js');
  const signal = platform.run.signalGroup, calls: number[] = [];
  const script = join(f.root, 'exit.cjs'); writeFileSync(script, 'process.stdout.write("{}");');
  try {
    platform.run.signalGroup = (pid, value) => { calls.push(pid); return signal(pid, value); };
    const request = { nodeExecutable: process.execPath, npmCli: script, args: [], cwd: f.root, environment: {}, maxStdoutBytes: 1024 };
    assert.equal((await runNpmProcess(request)).ok, true); assert(calls.length > 0);
    platform.run.signalGroup = () => { throw Error('synthetic signal fault'); };
    const result = await runNpmProcess(request); assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.kind, 'cleanup_failed');
    events.push({ platformSignalOwner: { calls, result } });
  } finally { platform.run.signalGroup = signal; }
}));

test('managed npm accepts bytes below the file cap; restoring the wrong shell unit rejects the same download', {timeout: 15000}, async t => fixture(t, async f => {
  const candidate = success(await f.observe()), folder = resolve('apps/backend/test-dist/release');
  const processSource = readFileSync(join(folder, 'npm-process.js'), 'utf8');
  const marker = 'Math.floor(request.maxFileBytes / 512)'; assert(processSource.includes(marker));
  const processFile = join(folder, `npm-process-units-${process.pid}.js`), downloadFile = join(folder, `npm-download-units-${process.pid}.js`);
  try {
    writeFileSync(processFile, processSource.replace(marker, 'Math.floor(request.maxFileBytes / 1024)'));
    writeFileSync(downloadFile, readFileSync(join(folder, 'npm-download.js'), 'utf8')
      .replace("'./npm-process.js'", JSON.stringify('./' + processFile.split('/').at(-1))));
    const mutated = await import(pathToFileURL(downloadFile).href);
    const normal = join(f.root, 'normal-units'), wrong = join(f.root, 'wrong-units'); mkdirSync(normal); mkdirSync(wrong);
    const signal = new AbortController().signal;
    const accepted = await downloadNpmTarball(f.registry, candidate, normal, signal, 1024 * 1024);
    const refused = await mutated.downloadNpmTarball(f.registry, candidate, wrong, signal, 1024 * 1024);
    events.push({fileLimitUnits: {bytes: 768 * 1024, maxBytes: 1024 * 1024, accepted, wrongUnits: refused}}); saveEvidence();
    assert.equal(accepted.ok, true, JSON.stringify(accepted));
    if (accepted.ok) assert.equal(accepted.bytes, 768 * 1024);
    assert.equal(refused.ok, false, JSON.stringify(refused));
  } finally { rmSync(processFile, {force: true}); rmSync(downloadFile, {force: true}); }
}, Buffer.alloc(768 * 1024, 120)));
