import { runRecordSchema } from '@alpacawork/contract/run';
import { fixtureAgentSetting, installAgentStub } from '../../tests/helpers/agent-stub.ts';
import { mkdirSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ControlStore, openControlDatabase, taskHash } from "@alpacawork/db";
import { RunStore } from "@alpacawork/runs";
import { TaskTransition } from "@alpacawork/backend/test-dist/control/task-transition.js";
import { PlacementStore } from "@alpacawork/backend/test-dist/control/placements.js";
import { writeTaskValues } from "@alpacawork/backend/test-dist/control/task-values-store.js";
import { stringify } from "yaml";
import { createSampleRuns, createSampleTasks, sampleTaskId } from "./sample.ts";

/** Generate into an empty data directory, using the current control database. */
export function generate(root: string): void {
  const tasks = createSampleTasks();
  mkdirSync(root, { recursive: true });
  if (readdirSync(root).length) throw new Error(`Fixture destination is not empty: ${root}`);
  installAgentStub(root, 'claude');
  const initialized = openControlDatabase(root, { busyTimeoutMs: 1000 }, false, true);
  initialized.close();
  const ids = new Map(tasks.map(task => [task.id, randomUUID()]));
  const byId = new Map(tasks.map(task => [task.id, task]));
  /** The nearest project above a sample Task: the one it belongs to. */
  const owningProject = (id: string): string => {
    const parent = byId.get(byId.get(id)!.parent!)!;
    return parent.kind === 'project' ? parent.id : owningProject(parent.id);
  };
  const control = new ControlStore(root);
  try {
    control.write(db => {
      // Parents first: the sample lists them in that order, and the shape triggers read a new Task's parent.
      const insertTask = db.prepare(`INSERT INTO tasks
        (id,kind,number,parent_id,project_task_id,title,lifecycle,base_state,hold,user_requested,settings,revision,created_at,updated_at)
        VALUES (?,?,?,?,?,?,'active',?,?,?,?,?,?,?)`);
      for (const task of tasks) {
        insertTask.run(ids.get(task.id)!, task.kind, Number(task.id.slice(1)), task.parent ? ids.get(task.parent)! : null,
          task.kind === 'project' ? null : ids.get(owningProject(task.id))!, task.title, task.state, 0,
          task.userRequested ? 1 : 0, task.kind === 'project' ? JSON.stringify({ color: '#39659b' }) : null, task.version, task.logs[0]!.at, task.logs.at(-1)!.at);
      }
      // Each Task's values as its owner writes them: a row per field (task_values).
      for (const task of tasks) writeTaskValues(db, task.id, task.values);
      db.prepare('UPDATE task_sequence SET next_number=? WHERE singleton=1')
        .run(Math.max(...tasks.map(task => Number(task.id.slice(1)))) + 1);
    });
  } finally { control.close(); }
  const owners = new Map<string, string>();
  const people = new Map<string, string>();
  const placements = new PlacementStore(root);
  let worker: string;
  try {
    for (const task of tasks) {
      if (!task.owner) continue;
      let person = people.get(task.owner);
      if (!person) { person = placements.createAgent().id; people.set(task.owner, person); }
      owners.set(task.id, placements.place({ taskId: task.id, agentId: person,
        profileKey: ["Astra", "Fable", "Codex", "Nova", "Orion"].includes(task.owner) ? "codex" : "missing",
        responsible: true }).id);
    }
    worker = placements.createAndPlace({ taskId: sampleTaskId("T1/T1/T1"), profileKey: "codex", responsible: false }).placement.id;
    // Written past the server, the sample keeps its invariant itself: a Task with children or at work has a responsible.
    const uncovered = placements.uncoveredTasks();
    if (uncovered.length) throw new Error(`Sample Tasks lack a responsible: ${uncovered.map(item => item.taskId).join(", ")}`);
  } finally { placements.close(); }
  writeFileSync(join(root, "config.yaml"), stringify({
    agents: {
      claude: fixtureAgentSetting('claude'),
      codex: fixtureAgentSetting('codex'),
    },
  }, { lineWidth: 0 }));
  const store = new RunStore(root, { busyTimeoutMs: 1000 });
  try {
    const db = new ControlStore(root);
    try {
      db.write(connection => {
        const insertLog = connection.prepare(`INSERT INTO task_log(id,task_id,ordinal,entry) VALUES (?,?,?,?)`);
        for (const task of tasks) task.logs.forEach((entry, ordinal) => {
          const placementId = entry.kind === 'reported' ? owners.get(task.id) : undefined;
          insertLog.run(`L${task.id}-${ordinal}`, ids.get(task.id)!, ordinal,
            JSON.stringify({ id: `L${task.id}-${ordinal}`, kind: entry.kind, at: entry.at,
              title: entry.title, description: entry.description,
              actor: placementId ? { kind: 'placement', placementId } : { kind: 'human' },
              fromState: null, toState: entry.toState ?? null,
              // The stored mark is the last creation's: the column and the log say the same.
              ...(entry.kind === 'created' ? { userRequested: task.userRequested } : {}) }));
        });
        for (const { record: sample, prompt, result } of createSampleRuns()) {
          const record = { ...sample, placementId: sample.role === "worker" ? worker : owners.get(sample.task)! };
          const taskUuid = ids.get(record.task)!;
          const requestUuid = record.requestId;
          if (requestUuid) connection.prepare(`INSERT INTO requests
            (id,task_id,placement_id,placement_revision,task_hash,head_run_id,mode,body,purpose,author,submitted_at,delivery_state)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(requestUuid, record.task, record.placementId,
              1, taskHash(taskUuid, tasks.find(task => task.id === record.task)!.version), null,
              'new', prompt, 'instruction', JSON.stringify({ kind: 'human' }), record.created_at, 'queued');
          // The Run's Task, placement and Request are read from its record.
          connection.prepare(`INSERT INTO runs(id,record,prompt,result,result_state) VALUES (?,?,?,?,?)`)
            .run(Number(record.id.slice(1)), JSON.stringify(runRecordSchema.parse(record)), prompt, result, result === null ? 'pending' : 'present');
        }
        connection.prepare('UPDATE run_sequence SET next_number=? WHERE singleton=1').run(createSampleRuns().length + 1);
      });
    } finally { db.close(); }
    store.write(runs => {
      for (const task of tasks) {
        const stop = store.connection.prepare("SELECT l.id FROM task_log l JOIN tasks t ON t.id=l.task_id WHERE t.external_id=? AND json_extract(entry,'$.toState')='stopped' ORDER BY ordinal DESC LIMIT 1").get(task.id);
        if(stop) store.connection.prepare('INSERT INTO task_stop_epochs(task_id,stop_id) VALUES (?,?)').run(task.id,String(stop.id));
      }
      for (const request of runs.requests()) new TaskTransition().captureStartGrant({ store, runs }, request.taskId, request.id, request.author);
    });
    for (const { record, result, stdoutModifiedAt } of createSampleRuns()) {
      const folder = store.prepareFolder(record.id);
      writeFileSync(join(folder, "stdout.log"), result === null ? "" : `${result}\n`);
      writeFileSync(join(folder, "stderr.log"), "");
      writeFileSync(join(folder, "manager.log"), "");
      for (const name of ["stdout.log", "stderr.log", "manager.log"])
        utimesSync(join(folder, name), new Date(stdoutModifiedAt), new Date(stdoutModifiedAt));
    }
  } finally { store.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2]) throw new Error("Usage: node e2e/fixture/generate.ts <empty-directory>");
  generate(resolve(process.argv[2]));
}
