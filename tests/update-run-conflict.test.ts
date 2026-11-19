/** Switch owns incompatibility; the controller preserves its typed reason through saved status. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { platform } from '@alpacawork/core';
import { updateStatusSchema } from '@alpacawork/contract';
import { managedUpdateFixture } from './helpers/managed-update.ts';
import { assembleFixtureDistribution, fixtureCommit } from './helpers/distribution-fixture.ts';

test('DB and FORMAT conflicts preserve unfinished Run counts through controller failure and public status without stopping', { skip: process.platform !== 'linux' && 'runs a linux-x64-glibc fixture image (Koffi native)', timeout: 60000 }, async t => {
  const f = await managedUpdateFixture(t), pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));
  pkg.version = '0.3.1';
  const sha = fixtureCommit(resolve('.'), join(f.root, 'objects'), 'run-conflict', { 'package.json': JSON.stringify(pkg) });
  const target = join(f.releases, sha);
  assembleFixtureDistribution(resolve('.'), join(f.root, 'candidate-build'), target, sha);
  const manifest = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'));
  const schema = JSON.parse(readFileSync(join(f.release, 'SCHEMA.json'), 'utf8'));
  const format = readFileSync(join(f.release, 'FORMAT'), 'utf8').trim();
  let reason: 'format' | 'database' = 'format';
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ workspace: f.workspace, schema: schema.control.version,
      control: reason === 'database' ? { ...schema.control, history: schema.control.history.slice(0, -1) } : schema.control,
      host: schema.host, unfinishedRuns: ['R1', 'R2', 'R3'], unpublishedStops: 0,
      contractUsers: reason === 'format' ? [{ runId: 'R1', attemptId: 'pending', format: format + '-different' }] : [] }));
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); }));
  const address = server.address(); assert(address && typeof address === 'object');
  writeFileSync(join(f.workspace, '.alpacawork/connection.json'), JSON.stringify({ url: `http://127.0.0.1:${address.port}/`, publicUrl: null, generation: randomUUID(), runManager: join(f.release, 'apps/backend/dist/run-manager.js') }));
  const savedEnv = { ...process.env };
  Object.assign(process.env, f.installationEnvironment);
  t.after(() => { for (const key of Object.keys(f.installationEnvironment)) { if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key]; } });
  t.mock.method(platform.service, 'observe', () => ({ state: 'matching', running: true, registrationStarts: false }));
  t.mock.method(platform.service, 'stop', () => assert.fail('a conflicting update must never stop the service'));
  const controller = await import(pathToFileURL(join(f.output, 'release/update-controller.js')).href);
  const records = await import(pathToFileURL(join(f.output, 'release/update-record.js')).href);
  const status = await import(pathToFileURL(join(f.output, 'release/update-status.js')).href);
  const installation = JSON.parse(readFileSync(join(f.home, '.config/alpacawork/installation.json'), 'utf8'));
  const opId = f.operation.acceptPreparedUpdate(f.runtime, { kind: 'prepared', origin: 'synthetic test', candidateId: randomUUID(), exactVersion: manifest.version,
    facts: manifest.alpacawork, edition: 'production', expectedActive: f.release }, { root: f.skills, place: ['alpacawork'] }, f.release, installation);
  const before = readFileSync(join(f.releases, 'switch.json'), 'utf8');
  for (reason of ['format', 'database'] as const) {
    await assert.rejects(controller.runUpdateController(f.runtime, opId), (error: any) => {
      assert.deepEqual(error.runConflict, { reason, runs: 3 });
      if (reason === 'format') {
        assert.deepEqual(error.detail.users, [{ runId: 'R1', attemptId: 'pending', format: format + '-different' }]);
        assert.equal(error.detail.remaining, 3);
      }
      return true;
    });
    const failure = records.readUpdateRecord(f.releases).operation.failure;
    assert.deepEqual(failure.runConflict, { reason, runs: 3 });
    const observed = updateStatusSchema.parse(status.updateStatus(f.workspace));
    assert.equal(observed.kind, 'failed');
    assert('runConflict' in observed); assert.deepEqual(observed.runConflict, { reason, runs: 3 });
    assert.equal(readFileSync(join(f.releases, 'switch.json'), 'utf8'), before);
  }
});
