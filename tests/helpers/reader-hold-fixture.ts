import { decideValues, seedValues } from './task-values.ts';
import { stringify } from 'yaml';
import { fixtureAgentSetting } from './agent-stub.ts';
/**
 * Canonical pause/restore projections for the Reader publication-order regression. Run in Node, outside jsdom. Two
 * Tasks the user asked for each have a question their responsible's Run asked the user; the user's proxy holds the
 * first one's, returns it to work and holds it again. Prints the held Task's ID and the tree at each step.
 */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { RunStore } from '@alpacawork/runs';
import { assignResponsible, initializeControlFixture } from './control-fixture.ts';
import { ControlTaskCommands } from '../../apps/backend/test-dist/control/task-commands.js';
import { ControlTaskStore } from '../../apps/backend/test-dist/control/task-store.js';
import { TaskRequestService } from '../../apps/backend/test-dist/control/task-request.js';
import { TaskReportService } from '../../apps/backend/test-dist/control/report.js';
import { readControlTree } from './control-tree.ts';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'alpacawork-reader-hold-')));
try {
  // A responsible needs a launch profile; no agent is launched here.
  writeFileSync(join(root, 'config.yaml'), stringify({ agents: { fake: fixtureAgentSetting('codex') } }));
  const project = initializeControlFixture(root);
  const commands = new ControlTaskCommands(root, { kind: 'human' }), tasks = new ControlTaskStore(root);
  const reports = new TaskReportService(root), person = { kind: 'human' } as const;
  const asked: string[] = [];
  for (let n = 0; n < 2; n++) {
    const { tasks: [created] } = await commands.create({ parentId: project, userRequested: true, tasks: [{
      title: `Question ${n + 1}`, values: { decide: [{ decide_question: 'Choose an option', decide_choices: [{ decide_choice: 'Proceed Go ahead', decide_choice_detail: 'Choose' }, { decide_choice: 'Wait Later', decide_choice_detail: 'Hold' }] }] } }] });
    const owner = await assignResponsible(root, created, 'fake');
    const { outcome: { request } } = await new TaskRequestService(root).request({ task: created.id, body: 'Work',
      opId: randomUUID(), expectedTaskHash: (await tasks.get(created.id)).hash, expectedPlacementRevision: owner.revision },
    person, person);
    // Its Run works, as its manager records it, and asks the user the body's question.
    const store = new RunStore(root, { busyTimeoutMs: 1_000 });
    try { store.write(tx => tx.update({ ...tx.get(request.runId)!, state: 'running', started_at: new Date().toISOString() })); }
    finally { store.close(); }
    await reports.report({ task: created.id, state: 'waiting', askTo: 'user', title: 'Please review', description: 'Question',
      opId: randomUUID(), expectedTaskHash: (await tasks.get(created.id)).hash }, { kind: 'placement', placementId: owner.id },
    { kind: 'run', runId: request.runId, placementId: owner.id, taskId: created.id, role: 'owner', responsible: true });
    asked.push(created.id);
  }
  const task = asked[0]!, first = await readControlTree(root);
  /** The user's proxy holds the question, or returns the Task to the work it was held from. */
  const pause = async (before: typeof first, state: 'held' | 'doing') => {
    const current = before.tasks.find(item => item.id === task)!;
    await reports.report({ task, expectedTaskHash: current.hash, state,
      title: state, description: 'pause/restore', opId: randomUUID() }, person, person);
    return readControlTree(root);
  };
  const held = await pause(first, 'held');
  const restored = await pause(held, 'doing');
  const heldAgain = await pause(restored, 'held');
  process.stdout.write(JSON.stringify({ task, asked: first, held, restored, heldAgain }));
} finally { rmSync(root, { recursive: true, force: true }); }
