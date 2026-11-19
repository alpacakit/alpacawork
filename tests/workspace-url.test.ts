import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { workspaceUrl } from '@alpacawork/backend/test-dist/receiver/workspace-url.js';
import { root, run, cli, start, stop } from './helpers/platform-http.ts';

const unavailable = { status: 'unavailable', localUrl: null, publicUrl: null };
const unverified = { status: 'unverified', localUrl: null, publicUrl: null };
async function urlResult() {
  const result = await run(['workspace', 'url']);
  return { code: result.code, body: JSON.parse(result.stdout) };
}

test('workspace url reports only the currently identified local serve', async () => {
  const first = await start();
  assert.deepEqual(await urlResult(), { code: 0, body: { status: 'serving', localUrl: first.url, publicUrl: null } });
  const old = readFileSync(first.connection, 'utf8');
  assert.deepEqual(await cli('workspace', 'url'), {
    status: 'serving', localUrl: first.url, publicUrl: null,
  });
  await stop(first);
  const next = await start();
  const current = readFileSync(next.connection, 'utf8');
  assert.notEqual(JSON.parse(current).generation, JSON.parse(old).generation);
  assert.deepEqual(await cli('workspace', 'url'), {
    status: 'serving', localUrl: next.url, publicUrl: null,
  });
  writeFileSync(next.connection, old);
  assert.deepEqual(await urlResult(), { code: 0, body: unavailable });
  writeFileSync(next.connection, JSON.stringify({ ...JSON.parse(current), generation: JSON.parse(old).generation }));
  assert.deepEqual(await urlResult(), { code: 0, body: unavailable });
  writeFileSync(next.connection, current);
  assert.equal((await cli('workspace', 'url')).localUrl, next.url);
  await stop(next);
});

test('workspace url exposes the public host declared at serve startup', async () => {
  const app = await start({ ALPACAWORK_TEST_PUBLIC_HOST: 'alpacawork.example.test:8443' });
  assert.deepEqual(await cli('workspace', 'url'), {
    status: 'serving', localUrl: app.url, publicUrl: 'https://alpacawork.example.test:8443/',
  });
  await stop(app);
});

test('workspace url rejects the old connection format', async () => {
  // The old file names a real server, which is not asked.
  let asked = 0;
  const server = createServer((_request, response) => { asked++; response.end('{}'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    writeFileSync(`${root}/.alpacawork/connection.json`, JSON.stringify({ url: `http://127.0.0.1:${address.port}/` }));
    assert.deepEqual(await workspaceUrl(root), unverified);
    assert.equal(asked, 0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('workspace url reports unverified when the identity response times out', async () => {
  const generation = randomUUID();
  const server = createServer((_request, response) => {
    setTimeout(() => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ generation, root }));
    }, 1800);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    writeFileSync(`${root}/.alpacawork/connection.json`, JSON.stringify({
      url: `http://127.0.0.1:${address.port}/`, publicUrl: null, generation, runManager: '/run-manager.js',
    }));
    assert.deepEqual(await workspaceUrl(root), unverified);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('workspace url identifies a live serve while its tree read is delayed', async () => {
  const generation = randomUUID();
  const server = createServer((request, response) => {
    if (request.url === '/api/workspace/live') {
      setTimeout(() => {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ generation, root }));
      }, 1800);
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ generation, root }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const localUrl = `http://127.0.0.1:${address.port}/`;
    writeFileSync(`${root}/.alpacawork/connection.json`, JSON.stringify({ url: localUrl, publicUrl: null, generation, runManager: '/run-manager.js' }));
    assert.deepEqual(await workspaceUrl(root), { status: 'serving', localUrl, publicUrl: null });
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
