import type { BridgeAdapterId } from '@alpacawork/contract/agent-adapters';
import { agentUsageSchema, type AgentUsage, type BridgeInstruction } from '@alpacawork/contract/agent-bridge';
import { RUN_FILES } from '@alpacawork/contract/run';
import type { RunFailure } from '@alpacawork/contract/run-failure';
import { bridgeActivity, ToolResults } from './activity.js';
import { readRunFile } from '../../runs/files.js';
import { JsonlReader, MAX_LINE } from '../../runs/readers/jsonl.js';
import { diagnosticFailure } from '@alpacawork/contract/agent-diagnostics';
import { object, resultFile, scanOutput } from './output.js';
import { catalogContext } from './skills.js';
import type { AgentAdapter, InputProtocol } from './types.js';

// Non-tool items do not attest to external work. Unknown item kinds with a lifecycle require a completion.
const codexTextItems = new Set(['agent_message', 'agent_configuration', 'reasoning', 'plan']);

export const bridgeInput: InputProtocol = {
  encode: (id, text): BridgeInstruction => ({ id, text }),
  receipt(value) {
    const row = object(value);
    if (typeof row.id !== 'string') return null;
    if (row.type === 'input.taken') return { id: row.id, outcome: 'taken' };
    if (row.type === 'input.not_sent') return { id: row.id,
      outcome: row.evidence === 'transfer_not_started' ? 'not_sent' : 'uncertain' };
    if (row.type === 'input.uncertain') return { id: row.id, outcome: 'uncertain' };
    return null; // Admission and a name such as input.refused are never processing evidence.
  },
  turnEnded: value => ['turn.completed', 'turn.failed'].includes(String(object(value).type)),
};
/** All bridge built-ins speak this boundary; only codex's known writer-lock exit has a special meaning. */
export function bridgeAdapter(id: BridgeAdapterId): AgentAdapter {
  return {
    input: bridgeInput, activity: bridgeActivity,
    skillCatalogContext: input => catalogContext(id, input),
    earlySession(invocation, folder) {
      try {
        let session: string | null = null;
        new JsonlReader().read(folder, value => {
          const row = object(value);
          if (!session && row.type === 'thread.started' && typeof row.thread_id === 'string' && row.thread_id) session = row.thread_id;
        });
        return invocation.session && invocation.session !== session ? null : session;
      } catch { return null; }
    },
    read(invocation, folder, exit) {
      let session: string | null = null, ended: 'completed' | 'failed' | null = null;
      let usage: AgentUsage | null = null, failure: RunFailure | undefined, invalid = false, invalidDiagnostic = false;
      let diagnosticSession: string | null = null;
      const tools = new ToolResults();
      const { rejection, outcomeRejection } = scanOutput(folder, value => {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) invalidDiagnostic = true;
        const row = object(value);
        // A diagnostic event must belong to the root and to the selected conversation.
        const diagnosticOwner = row.parent_tool_use_id == null && (row.session_id == null ||
          row.session_id === (invocation.session ?? (row.type === 'thread.started' ? row.thread_id : diagnosticSession)));
        if (diagnosticOwner && row.type === 'thread.started') {
          diagnosticSession = typeof row.thread_id === 'string' ? row.thread_id : null;
          failure = undefined;
        } else if (diagnosticOwner && diagnosticSession && (!invocation.session || invocation.session === diagnosticSession) &&
          (row.thread_id == null || row.thread_id === diagnosticSession)) {
          if (row.type === 'turn.started' || row.type === 'turn.completed') failure = undefined;
          if (row.type === 'error') failure = diagnosticFailure(row.message);
          if (row.type === 'turn.failed') {
            const error = object(row.error), read = diagnosticFailure(error.message);
            const cause = id !== 'codex' ? undefined : error.codexErrorInfo === 'usageLimitExceeded' ? 'session_limit'
              : error.codexErrorInfo === 'serverOverloaded' ? 'model_capacity' : undefined;
            failure = cause ? { message: read?.message ?? 'Agent unavailable', cause } : read ?? failure;
          }
        }
        if (!session && row.type === 'thread.started' && typeof row.thread_id === 'string' && row.thread_id) session = row.thread_id;
        if (row.type === 'thread.started' && row.thread_id !== session) invalid = true;
        if (!session || row.thread_id != null && row.thread_id !== session) return;
        if (id === 'codex' && (row.type === 'item.started' || row.type === 'item.completed')) {
          const item = object(row.item);
          if (!codexTextItems.has(String(item.type)))
            tools.observe([{ kind: row.type === 'item.started' ? 'tool_start' : 'tool_end', id: item.id }]);
        }
        if (row.type === 'turn.started') { ended = null; usage = null; }
        if (row.type === 'turn.failed') { ended = 'failed'; usage = null; }
        if (row.type === 'turn.completed') {
          ended = 'completed';
          const parsed = agentUsageSchema.safeParse(row.usage);
          usage = parsed.success ? parsed.data : null;
          return diagnosticOwner && (!invocation.session || invocation.session === session);
        }
      });
      const sameSession = !invalid && (!invocation.session || invocation.session === session);
      const base = { session: sameSession ? session : null, usage: sameSession ? usage : null,
        ...(!rejection && !invalidDiagnostic && diagnosticSession &&
          (!invocation.session || invocation.session === diagnosticSession) && failure ? { failure, toolsSettled: tools.complete && ended === 'failed' && id === 'codex' } : {}) };
      if (id === 'codex' && invocation.mode === 'resume' && exit.code === 1 && exit.signal === null) {
        try {
          if (readRunFile(folder, RUN_FILES.stderr, MAX_LINE).toString('utf8').includes('already has an active writer'))
            return { ...base, outcome: { state: 'needs_review', reason: 'conversation_busy' } };
        } catch { /* The existing special-case evidence is unproved. */ }
      }
      const reply = resultFile(folder);
      if (exit.code !== 0 || exit.signal !== null) return { ...base, outcome: { state: 'failed', reason: 'exit',
        ...(reply.result !== null ? { result: reply.result } : { resultState: reply.rejection! }) } };
      if (outcomeRejection || !sameSession || !session || ended !== 'completed' || reply.rejection)
        return { ...base, outcome: { state: 'failed', reason: 'output',
          ...(outcomeRejection || reply.rejection ? { resultState: outcomeRejection ?? reply.rejection! } : {}) } };
      return { ...base, outcome: { state: 'succeeded', session, result: reply.result } };
    },
  };
}
