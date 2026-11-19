import { fixtureAgentSetting } from './helpers/agent-stub.ts';
import { stringify } from 'yaml';
import { assignResponsible, initializeControlFixture } from './helpers/control-fixture.ts';
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../apps/backend/test-dist/receiver/server.js";
import { FileWriter } from "@alpacawork/backend/test-dist/raw/storage.js";
import { ControlTaskCommands } from "@alpacawork/backend/test-dist/control/task-commands.js";
import { projectedIndexSchema } from "@alpacawork/contract/control";

test("production assets are served, RAW files are not, and browser snapshots match the wire contract", async () => {
  const area = realpathSync(mkdtempSync(join(tmpdir(), "alpacawork-web-")));
  const root = join(area, "tasks");
  mkdirSync(root);
  const writer = new FileWriter(root);
  let project: string;
  try {
    writer.save("config.yaml", null, Buffer.from(
      stringify({ agents: { "fake": fixtureAgentSetting('codex') } })));
    project = initializeControlFixture(root);
  } finally { writer.close(); }
  const commands = new ControlTaskCommands(root, { kind: "human" });
  const initialized = (await commands.create({ parentId: project, userRequested: null, tasks: [{ title: "Browser contract" }] })).tasks[0];
  // A task with a child has its responsible.
  await assignResponsible(root, initialized, "fake");
  await commands.create({ parentId: initialized.id, userRequested: false, tasks: [{ title: "Child" }] });
  const app = await startServer(root, 0);
  const base = new URL(app.url).origin;
  try {
    const page = await fetch(base);
    assert.equal(page.status, 200);
    assert.ok(
      page.headers
        .get("content-security-policy")
        ?.includes("script-src 'self'"),
    );
    const html = await page.text();
    assert.equal(html.includes('name="alpacawork-voice"'), false, 'unconfigured voice is not advertised');
    assert.ok(!page.headers.get('content-security-policy')?.includes('wss:'), 'no speech provider is allowed by CSP');
    const unknown = await fetch(base + '/api/not-a-feature', { method: 'POST' });
    const absent = await unknown.json();
    for (const route of ['/api/voice/token', '/api/voice/transcriptions']) {
      const response = await fetch(base + route, { method: 'POST' });
      assert.equal(response.status, unknown.status);
      assert.deepEqual(await response.json(), absent, 'voice has the ordinary absent-endpoint response');
      assert.equal(response.headers.get('cache-control'), unknown.headers.get('cache-control'));
    }
    const asset = html.match(/src="(\/assets\/[^" ]+\.js)"/)?.[1];
    assert.ok(asset, "production HTML must load the React build");
    assert.equal((await fetch(base + asset)).status, 200);
    // Only the packaged build is served: workspace files and paths that try to
    // escape the manifest are not assets, so they reach no handler at all.
    assert.equal((await fetch(base + "/index.md")).status, 404);
    assert.equal(
      (await fetch(base + "/assets/../../src/receiver/server.ts")).status,
      404,
    );
    const response = await fetch(base + "/api/workspace/live");
    const snapshot = projectedIndexSchema.parse(await response.json());
    // Its project rows (the root P1 and the fixture's) come with the two tasks.
    assert.equal(snapshot.tasks.filter(task => task.kind === "task").length, 2);
    assert.equal(snapshot.writable, true);
    assert.equal(
      (await fetch(base, { headers: { Origin: "http://evil.invalid" } }))
        .status,
      403,
    );
  } finally {
    await app.close();
    rmSync(area, { recursive: true });
  }
});
