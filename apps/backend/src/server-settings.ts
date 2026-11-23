import type { BuiltinAdapterId } from '@alpacawork/contract/agent-adapters';
/**
 * The settings screen's part of config.yaml: this PC's limits and `agents:` block as written. A save checks the same
 * rules as every read (`@alpacawork/contract`), so no writer can leave a config that runs break on. A project's title,
 * body and extracts are its Task's own (task update); its code location is project-settings'.
 */
import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { ControlStore } from '@alpacawork/db';
import { CONFIG_FILE, digest, type TaskActor } from '@alpacawork/raw';
import { PROBLEM_CODE, Problem, errorBody } from '@alpacawork/core';
import { adapterCatalog, agentSettingSchemaFor, compileAgentSetting, resolveAgentSelection, stackRowValues } from '@alpacawork/contract';
import type { ServerSettings } from '@alpacawork/contract';
import type { ConfigSetValues } from '@alpacawork/contract/inputs';
import { parseConfig, requireConfigBytes } from './config.js';
import { parseAgentsSettings } from './agents-settings.js';
import { inspectAgents, inspectAgent, type InspectionEnvironment } from './agents/availability.js';
import { FileWriter } from './raw/storage.js';
import { requirePublished, FileJournal } from './control/file-journal.js';

const decode = (bytes: Uint8Array) => new TextDecoder('utf-8', { fatal: true }).decode(bytes);

/** Where the `agents:` block is written in the file: its key through its value and the comments it carries. */
function agentsBlock(text: string): { start: number; end: number } {
  const { document } = parseConfig(text);
  const contents = document.contents as { items?: { key: { value?: unknown; range?: number[] }; value?: { range?: number[] } }[] } | null;
  const pair = contents?.items?.find(item => item.key.value === 'agents');
  if (!pair?.key.range || !pair.value?.range) throw new Problem(PROBLEM_CODE.invalidSettings, `${CONFIG_FILE} has no agents`, undefined,
    { reason: { kind: 'config_section_missing', path: CONFIG_FILE, section: 'agents' } });
  return { start: pair.key.range[0]!, end: pair.value.range[2]! };
}
/** The screen's hash is the digest of config.yaml's bytes, so any change to the file refuses a stale save. */
function view(bytes: Buffer): ServerSettings {
  const text = decode(bytes);
  const config = parseAgentsSettings(text);
  const block = agentsBlock(text);
  const agentsText = text.slice(block.start, block.end);
  // A task's launch can still carry latent defaults. The editable rows only expose choices that apply.
  const aiStack = config.aiStack?.map(row => {
    const compiled = compileAgentSetting(row.agent, config.agents[row.agent]!);
    return { agent: row.agent, values: stackRowValues(compiled, resolveAgentSelection(compiled, row.values)) };
  });
  return { hash: digest(bytes), limits: config.limits, agentsText, agents: config.agents,
    ...(aiStack === undefined ? {} : { aiStack }),
    ...(config.coordinatorAiStack === undefined ? {} : { coordinatorAiStack: config.coordinatorAiStack }), catalog: adapterCatalog() };
}
export async function readServerSettings(root: string): Promise<ServerSettings> {
  let writer: FileWriter | undefined;
  try {
    new FileJournal(root).assertAvailable(CONFIG_FILE);
    writer = new FileWriter(root);
    return view(requireConfigBytes(writer));
  } catch (error) {
    return { hash: null, limits: parseAgentsSettings('agents: {}').limits, agentsText: '', agents: {}, catalog: adapterCatalog(), error: errorBody(error).error };
  } finally { writer?.close(); }
}

/**
 * Saves the limits and the agents block at once against the screen's hash. The agents block replaces its own lines as
 * typed; limits are written only where they changed. The publication receipt retains the authorized actor and time;
 * its old/new digests and saved view identify what changed. Retries retain that first receipt.
 */
export async function saveServerSettings(root: string, input: ConfigSetValues, opId: string = randomUUID(),
  actor: TaskActor = { kind: 'human' }): Promise<ServerSettings> {
  const edit = input.edit;
  const key = [input.expectedConfigHash, input.agents, edit, actor];
  const journal = new FileJournal(root);
  const replay = journal.replayConfig<ServerSettings>(opId, key);
  if (replay) {
    requirePublished(replay);
    return replay.body;
  }
  journal.assertAvailable(CONFIG_FILE);
  const agentsText = input.agents.endsWith('\n') ? input.agents : `${input.agents}\n`;
  let writer: FileWriter | undefined;
  try {
    writer = new FileWriter(root);
    return await writer.locked(async () => {
      const beforeBytes = writer!.read(CONFIG_FILE) ?? Buffer.alloc(0);
      // A config.yaml the screen cannot read is refused as such, before any staleness.
      const before = decode(beforeBytes);
      const current = view(beforeBytes);
      const { document, values } = parseConfig(before);
      if (digest(beforeBytes) !== input.expectedConfigHash)
        throw new Problem(PROBLEM_CODE.conflict, 'Settings changed; reload before retrying', { path: CONFIG_FILE }, { reason: { kind: 'settings_changed' } });
      let rewrite = false;
      for (const [key, value] of Object.entries(edit.limits))
        if (value !== current.limits[key as keyof typeof current.limits]) { document.setIn(['limits', key], value); rewrite = true; }
      for (const key of ['aiStack', 'coordinatorAiStack'] as const) {
        const currentRows = key === 'aiStack' ? current.aiStack : values.coordinatorAiStack;
        if (edit[key] === undefined || isDeepStrictEqual(edit[key], currentRows)) continue;
        document.set(key, edit[key]);
        rewrite = true;
      }
      /* Initial release: Jev settings are not editable.
      if (edit.jev !== undefined && JSON.stringify(edit.jev) !== JSON.stringify(parseJevSettings(parseConfig(before).values.jev))) {
        document.set('jev', edit.jev);
        rewrite = true;
      }
      */
      // The agents block goes in as typed, even when serializing the other edits.
      const render = (base: string) => {
        const block = agentsBlock(base);
        return Buffer.from(base.slice(0, block.start) + agentsText + base.slice(block.end));
      };
      let output = render(rewrite ? document.toString({ lineWidth: 0 }) : before);
      let saved = view(output);
      // The new agents block decides which coordinator values are active.
      if (edit.coordinatorAiStack !== undefined && !isDeepStrictEqual(edit.coordinatorAiStack, saved.coordinatorAiStack)) {
        document.set('coordinatorAiStack', saved.coordinatorAiStack);
        output = render(document.toString({ lineWidth: 0 }));
        saved = { ...saved, hash: digest(output) };
      }
      // An unchanged file still answers this operation once, by a receipt that changes nothing else.
      if (output.equals(Buffer.from(before))) {
        const store = new ControlStore(root, { busyTimeoutMs: 10_000 });
        try { return store.writeOperation({ opId, operation: 'config.set',
          fingerprint: digest(Buffer.from(JSON.stringify(['config.set', key]))) }, db => {
          if (db.prepare('SELECT 1 FROM file_path_reservations WHERE path=?').get(CONFIG_FILE))
            throw new Problem(PROBLEM_CODE.conflict, 'Config file is reserved', undefined, { reason: { kind: 'config_file_reserved' } });
          return { status: 200, body: saved };
        }).body; } finally { store.close(); }
      }
      const outcome = journal.putConfig({ opId, bytes: output,
        expectedDigest: digest(beforeBytes), result: saved, fingerprintKey: key,
        audit: { actor, at: new Date().toISOString() } });
      requirePublished(outcome);
      return outcome.body;
    });
  } catch (error) {
    if (error instanceof Problem) throw error;
    throw new Problem(PROBLEM_CODE.ioFailure, 'Cannot confirm the settings were saved; reload and check the saved content', undefined,
      { reason: { kind: 'cannot_confirm_settings_were_saved_reload_and_check_saved_content' }, cause: error });
  } finally { writer?.close(); }
}

/** Ordinary reads start no executables; an explicit check adds fresh host observations. */
export async function inspectServerSettings(root: string, input: { adapter?: BuiltinAdapterId; command?: string; check?: boolean } = {}, environment?: InspectionEnvironment): Promise<ServerSettings> {
  const settings = await readServerSettings(root);
  if (!input.check) return settings;
  const observations = input.adapter ? {} : await inspectAgents(settings.agents, environment);
  const inspected = input.adapter && input.command !== undefined ? await inspectAgent(input.adapter,
    agentSettingSchemaFor(input.adapter).parse({ command: input.command }), environment, true) : undefined;
  return { ...settings, ...observations, ...(inspected ? { inspected } : {}) };
}
