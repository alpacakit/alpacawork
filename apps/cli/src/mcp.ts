import { isAbsolute } from 'node:path';
import { once } from 'node:events';
import { z } from 'zod';
import { CLI_CONTRACT, CONTRACT_HEADER } from '@alpacawork/contract/client-contract';
import { byteInputFromMcp, commandCatalog } from '@alpacawork/contract/commands';
import { mcpPath, mcpRelayHeader, mcpRequestBytes, mcpWriteTool } from '@alpacawork/contract/mcp';
import { RESTORE_HEADER, restoreIdSchema } from '@alpacawork/contract/recovery';
import { errorBody, parseInput, Problem, PROBLEM_CODE } from '@alpacawork/core';
import { prepareByteUpload } from './byte-upload.js';
import { ATTEMPT_MS, LostAnswer, RemoteProblem, request, runCredentialHeaders } from './transport.js';

const rpc = z.object({ jsonrpc: z.literal('2.0'), id: z.union([z.string(), z.number().int()]).optional(), method: z.string(),
  params: z.unknown().optional() });
const selection = z.object({ name: z.literal(mcpWriteTool), arguments: z.object({
  command: z.string(), input: z.record(z.string(), z.unknown()), opId: z.string().optional(), restoreId: restoreIdSchema,
}) });
const relayOutput = z.object({ error: z.unknown().optional(), result: z.object({
  protocolVersion: z.string().optional(), isError: z.boolean().optional(), content: z.array(z.unknown()).optional(),
}).loose().optional() }).loose();
const transfer = z.object({ transfer: z.literal(true), restoreId: restoreIdSchema });
const commandByName = new Map(commandCatalog.commands.map(command => [command.words.join(' '), command]));

export function mcpCredentialHeaders(useRun: boolean, env: NodeJS.ProcessEnv): Headers {
  return runCredentialHeaders(env, useRun);
}

/** Bound each message while reading it, even if the client never sends a newline. */
async function* stdioMessages() {
  let chunks: Buffer[] = [], size = 0;
  for await (const chunk of process.stdin as AsyncIterable<Buffer>) {
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const end = newline === -1 ? chunk.length : newline;
      size += end - offset;
      if (size <= mcpRequestBytes) chunks.push(chunk.subarray(offset, end));
      else chunks = [];
      if (newline === -1) break;
      yield size <= mcpRequestBytes ? Buffer.concat(chunks, size).toString('utf8') : null;
      chunks = [];
      size = 0;
      offset = end + 1;
    }
  }
}

/** A stdio MCP client speaks newline-delimited JSON-RPC; the server handles every MCP decision. */
export async function relayMcp(origin: string, useRun: boolean) {
  const credentials = mcpCredentialHeaders(useRun, process.env);
  const endpoint = new URL(mcpPath, origin);
  let version: string | undefined;
  const uploads = new Map<string, string>();
  const send = async (reply: unknown) => {
    if (!process.stdout.write(JSON.stringify(reply) + '\n')) await once(process.stdout, 'drain');
  };

  for await (const line of stdioMessages()) {
    let incoming: z.infer<typeof rpc>;
    try {
      if (line === null) throw new Error();
      incoming = rpc.parse(JSON.parse(line));
    } catch {
      await send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid or oversized JSON-RPC request' } });
      continue;
    }
    const selected = selection.safeParse(incoming.params);
    const args = incoming.method === 'tools/call' && selected.success ? selected.data.arguments : undefined;
    const spec = args && typeof args.input.file === 'string' ? commandByName.get(args.command) : undefined;
    const file = useRun && spec?.file?.body === 'bytes' && args?.opId ? { ...args, opId: args.opId } : undefined;
    const headers = new Headers(credentials);
    headers.set('Accept', 'application/json, text/event-stream');
    headers.set('Content-Type', 'application/json');
    if (version) headers.set('MCP-Protocol-Version', version);
    if (file) headers.set(mcpRelayHeader, '1');
    try {
      const response = await fetch(endpoint, { method: 'POST', headers, body: line, redirect: 'error',
        signal: AbortSignal.timeout(ATTEMPT_MS) }).catch(() => { throw new LostAnswer('no_answer'); });
      if (incoming.id === undefined) {
        await response.body?.cancel();
        continue;
      }
      const answer = relayOutput.parse(await response.json().catch(() => { throw new LostAnswer('incomplete'); }));
      if (incoming.method === 'initialize' && answer.result?.protocolVersion) version = answer.result.protocolVersion;
      if (file && spec?.file && !answer.result?.isError && answer.result?.content?.[0]) {
        const confirmation = z.object({ text: z.string() }).parse(answer.result.content[0]);
        const approved = transfer.parse(JSON.parse(confirmation.text));
        if (approved.restoreId !== file.restoreId)
          throw new Problem(PROBLEM_CODE.restoreChanged, 'The workspace was restored; read it again before uploading');
        const { file: source, ...destination } = file.input;
        if (typeof source !== 'string' || !isAbsolute(source))
          throw new Problem(PROBLEM_CODE.invalidInput, 'Expected an absolute file path');
        const parsed = parseInput(spec.schema, byteInputFromMcp(spec, destination)) as Record<string, unknown>;
        const prepared = await prepareByteUpload(spec.file, parsed, source);
        const fingerprint = JSON.stringify([file.restoreId, file.command, prepared.path, [...prepared.headers], prepared.digest]);
        const previous = uploads.get(file.opId);
        if (previous !== undefined && previous !== fingerprint)
          throw new Problem(PROBLEM_CODE.idempotencyConflict, 'This operation ID was used with different upload input');
        uploads.set(file.opId, fingerprint);
        const byteHeaders = new Headers(credentials);
        prepared.headers.forEach((value, key) => byteHeaders.set(key, value));
        byteHeaders.set('X-Alpacawork-Client', 'cli');
        byteHeaders.set(CONTRACT_HEADER, String(CLI_CONTRACT));
        byteHeaders.set('X-Alpacawork-Op-Id', file.opId);
        byteHeaders.set(RESTORE_HEADER, file.restoreId);
        const result = await request(origin, prepared.path, spec.file.method, prepared.bytes, byteHeaders);
        answer.result = { content: [{ type: 'text', text: JSON.stringify({
          ...(result as Record<string, unknown>), restoreId: approved.restoreId,
        }) }] };
      }
      await send({ ...answer, jsonrpc: '2.0', id: incoming.id });
    } catch (error) {
      if (incoming.id === undefined) continue;
      if (incoming.method !== 'tools/call') {
        await send({ jsonrpc: '2.0', id: incoming.id, error: { code: -32000, message: 'The server gave no complete MCP answer' } });
        continue;
      }
      const problem = error instanceof LostAnswer
        ? new Problem(PROBLEM_CODE.unavailable, args?.command === 'config inspect'
          ? 'Execution result unknown; the server did not return a complete answer'
          : args?.opId ? 'Save result unknown; repeat with the same opId, restoreId and input' : error.message,
        { state: 'result_unknown' })
        : error;
      await send({ jsonrpc: '2.0', id: incoming.id, result: { isError: true, content: [{ type: 'text',
        text: JSON.stringify(problem instanceof RemoteProblem ? problem.body : errorBody(problem)) }] } });
    }
  }
}
