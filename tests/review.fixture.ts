import { controlTaskView } from '@alpacawork/backend/test-dist/control/task-dto.js';
import { rememberEvidenceWorkspace } from './helpers/failure-workspace.ts';
import { assignResponsible, initializeControlFixture } from './helpers/control-fixture.ts';
import { cleanCliEnv } from './helpers/http-cli.ts';
import { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { RunStore } from '@alpacawork/runs';
import type { RunId } from '@alpacawork/contract/fields';
import { FileWriter } from '@alpacawork/backend/test-dist/raw/storage.js';
import { inertAgentTemplate } from './helpers/inert-agent-template.ts';
import { ControlTaskCommands } from '@alpacawork/backend/test-dist/control/task-commands.js';
import { ControlTaskStore } from '@alpacawork/backend/test-dist/control/task-store.js';
import { TaskRequestService } from '@alpacawork/backend/test-dist/control/task-request.js';
import { TaskReportService } from '@alpacawork/backend/test-dist/control/report.js';
import { startServer } from '@alpacawork/backend/test-dist/receiver/server.js';
import { reconcileLinks } from './return-handling.fixture.ts';

function writeDescription(root: string, text: string): string {
  const path = join(root, 'review-description.md');
  writeFileSync(path, text);
  return path;
}

async function reportViaCli(root: string, serverUrl: string, ...args: string[]): Promise<unknown> {
  const command = spawn(process.execPath, [fileURLToPath(new URL('../apps/cli/dist/cli.js', import.meta.url)),
    '--server', serverUrl, 'task', 'report', ...args], { env: cleanCliEnv() });
  let stdout = '', stderr = '';
  command.stdout.on('data', chunk => { stdout += chunk; });
  command.stderr.on('data', chunk => { stderr += chunk; });
  const code = await new Promise<number | null>(resolve => command.on('close', resolve));
  assert.equal(code, 0, stderr);
  return JSON.parse(stdout);
}

/**
 * A Task whose responsible's Run reported done and ended: with `userRequested` true it awaits the user's review, else
 * it is done. The user asked its responsible through task request; the Run's start and end are the store's, as its
 * manager writes them, and its done is task report's, as the Run's own. Returns the Task as task get shows it once the
 * Run's boundaries are applied, `reviewRun` (the Run a confirmation or a send-back names with --about-run) and the
 * versions they are checked against. No process runs until the test starts a server.
 */
async function setupReview(t: TestContext, { userRequested }: { userRequested: boolean }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'alpacawork-review-')));
  rememberEvidenceWorkspace(t,root);
  const servers: Array<Awaited<ReturnType<typeof startServer>>> = [];
  t.after(async () => {
    for (const server of servers) await server.close();
    rmSync(root, { recursive: true, force: true });
  });
  const writer = new FileWriter(root);
  let project: string;
  try { writer.save('config.yaml', null, Buffer.from(inertAgentTemplate(root))); project = initializeControlFixture(root); }
  finally { writer.close(); }
  const commands = new ControlTaskCommands(root, { kind: 'human' }), tasks = new ControlTaskStore(root);
  const created = (await commands.create({ parentId: project, userRequested, tasks: [{ title: 'Review target' }] })).tasks[0];
  const placement = await assignResponsible(root, created, 'claude');
  const human = { kind: 'human' } as const;
  const { outcome: { request } } = await new TaskRequestService(root).request({ task: created.id, body: 'First',
    opId: randomUUID(), expectedTaskHash: (await tasks.get(created.id)).hash, expectedPlacementRevision: placement.revision },
  human, human);
  const reviewRun: RunId = request.runId;
  const store = new RunStore(root, { busyTimeoutMs: 0 });
  try {
    store.write(tx => tx.update({ ...tx.get(reviewRun)!, state: 'running', started_at: new Date().toISOString() }));
    await new TaskReportService(root).report({ task: created.id, state: 'done', title: 'Please review', description: 'The result is ready for review.', opId: randomUUID(),
      expectedTaskHash: (await tasks.get(created.id)).hash }, { kind: 'placement', placementId: placement.id },
    { kind: 'run', runId: reviewRun, placementId: placement.id, taskId: created.id, role: 'owner', responsible: true });
    store.write(tx => tx.finish({ ...tx.get(reviewRun)!, state: 'succeeded', ended_at: new Date().toISOString() },
      { state: 'present', text: 'fixture reply' }));
  } finally { store.close(); }
  reconcileLinks(root, project);
  const task = controlTaskView(await tasks.get(created.id));
  assert.equal(task.state, userRequested ? 'waiting' : 'done');
  return { root, project, commands, placement, task, reviewRun, expectedTaskHash: task.hash,
    expectedPlacementRevision: placement.revision, async start() {
      const server = await startServer(root, 0);
      servers.push(server);
      return server;
    } };
}

export { writeDescription, reportViaCli, setupReview };
