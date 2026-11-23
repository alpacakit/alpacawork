import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import type { Hono } from 'hono';
import { z } from 'zod';
import { CLI_CONTRACT, CONTRACT_HEADER } from '@alpacawork/contract/client-contract';
import { byteInputFromMcp, byteRequest, commandCatalog, type Command } from '@alpacawork/contract/commands';
import {
  mcpFileReadOptions, mcpInlineFileBytes, mcpPath, mcpProtocolVersions, mcpReadTool,
  mcpRelayHeader, mcpSourceHeader, mcpWriteTool, type McpFileReadOptions,
} from '@alpacawork/contract/mcp';
import { RESTORE_HEADER, restoreIdSchema } from '@alpacawork/contract/recovery';
import { errorBody, failure, parseInput, Problem, PROBLEM_CODE } from '@alpacawork/core';
import { verifyRunCredential, type CallerClaim } from '../control/credentials.js';
import { restoreId } from '../release/journal.js';
import { commandOrigin } from './command-links.js';
import { claimOf, jsonHeaders } from './request-scope.js';

const commands = new Map(commandCatalog.commands.map(command => [command.words.join(' '), command]));
const inputSchema = z.record(z.string(), z.json());
const callSchema = z.object({ name: z.enum([mcpReadTool, mcpWriteTool]), arguments: z.unknown().optional() }).strict();
const selection = { command: z.string(), input: inputSchema.optional() };
const writeArgs = z.object({ ...selection, restoreId: restoreIdSchema, opId: z.string().min(1).max(256).refine(value => /^[!-~]+$/.test(value), 'Use visible ASCII characters').optional() }).strict();
const readArgs = z.object(selection).strict();
// MCP metadata belongs to the request envelope. Keep method parameters for their own validation.
const requestParams = z.looseObject({ _meta: z.record(z.string(), z.unknown()).optional() })
  .transform(({ _meta, ...params }) => params);
const envelope = z.object({ jsonrpc: z.literal('2.0'), id: z.union([z.string(), z.number().int()]).optional(),
  method: z.string(), params: requestParams.optional() });
const inline = z.object({ content: z.string().optional(), contentBase64: z.string().optional(), file: z.string().optional() })
  .superRefine((value, ctx) => {
    if (Object.values(value).filter(item => item !== undefined).length !== 1)
      ctx.addIssue({ code: 'custom', path: ['content'], message: 'Supply exactly one of content, contentBase64 or file' });
  });

type Options = {
  root: string;
  enabled: boolean;
  publicHost?: string;
  version: string;
  readJson: (request: Request) => Promise<unknown>;
  forward: (request: Request, fileRead?: McpFileReadOptions) => Response | Promise<Response>;
  authorizeUpload: (claim: CallerClaim, task: string) => void;
};
type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
const terminalInstructions = 'You are running as an alpacawork Task placement. Follow the launch request and the alpacawork owner or member skill. Read guide for skill files and help for command inputs.';
const coordinatorInstructions = 'Alpacawork manages Tasks and AI Runs. You act as the user’s coordinator. Before your first write, read guide with name SKILL.md. Use help for command inputs. Alpacawork-launched Runs use the stdio relay registered with --run.';

function invalid(path: string, message: string): never {
  throw new Problem(PROBLEM_CODE.invalidInput, message, undefined,
    { reason: { kind: 'validation_error' }, issues: [{ path, code: 'invalid_value', message }] });
}
function toolDefinitions() {
  const read = [...commands.entries()].filter(([, command]) => command.kind === 'read').map(([name]) => name);
  const write = [...commands.entries()].filter(([, command]) => command.kind !== 'read').map(([name]) => name);
  const shape = (names: string[], extra: Record<string, object>, required: string[]) => ({
    type: 'object', properties: { command: { type: 'string', enum: names }, input: { type: 'object' }, ...extra },
    required: ['command', ...required], additionalProperties: false,
  });
  return [
    { name: mcpReadTool, description: 'Read alpacawork. Use help for command inputs or guide for a skill file.',
      annotations: { readOnlyHint: true }, inputSchema: shape(read, {}, []) },
    { name: mcpWriteTool, description: 'Save or run an alpacawork command. Copy restoreId from the last read. For saves, reuse the same opId and input if the result is unknown.',
      inputSchema: shape(write, { restoreId: { type: 'string' }, opId: { type: 'string' } }, ['restoreId']) },
  ];
}
const tools = toolDefinitions();

function rpc(id: string | number | null, result: unknown): Response {
  return Response.json({ jsonrpc: '2.0', id, result }, { headers: jsonHeaders });
}
function rpcError(id: string | number | null, code: number, message: string, status = 200): Response {
  return Response.json({ jsonrpc: '2.0', id, error: { code, message } }, { status, headers: jsonHeaders });
}
function text(value: unknown): Content { return { type: 'text', text: JSON.stringify(value) }; }
function withIdentity(root: string, value: unknown) {
  return { ...(value !== null && typeof value === 'object' && !Array.isArray(value) ? value : { result: value }), restoreId: restoreId(root) };
}
const errorResult = (value: unknown) => ({ isError: true, content: [text(value)] });
const announced = (root: string, value: unknown) => ({ content: [text(withIdentity(root, value))] });

function permittedClaim(root: string, request: Request) {
  if (request.headers.has(mcpSourceHeader) || request.headers.has('x-alpacawork-provider') || request.headers.has('x-alpacawork-conversation'))
    throw new Problem(PROBLEM_CODE.forbidden, 'Invalid direct conversation headers', undefined,
      { reason: { kind: 'invalid_direct_conversation_headers' } });
  const headers = new Headers(request.headers);
  headers.delete(mcpRelayHeader);
  const claim = claimOf(headers, false, true);
  if (claim.run && !verifyRunCredential(root, claim.run.runId, claim.run.token))
    throw new Problem(PROBLEM_CODE.forbidden, 'Run credential is missing or invalid', undefined,
      { reason: { kind: 'run_credential_missing_or_invalid' } });
  return claim;
}

function query(url: URL, input: Record<string, unknown>) {
  for (const [key, value] of Object.entries(input)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item === null || typeof item === 'object') invalid(key, 'Read inputs take scalar values or lists of scalars');
      url.searchParams.append(key, String(item));
    }
  }
}

function upload(data: z.infer<typeof inline>) {
  const bytes = data.contentBase64 === undefined ? Buffer.from(data.content!) : Buffer.from(data.contentBase64, 'base64');
  if (data.contentBase64 !== undefined && bytes.toString('base64') !== data.contentBase64)
    invalid('contentBase64', 'Use standard padded base64');
  if (bytes.length > mcpInlineFileBytes) {
    const message = 'Inline files are limited to 8 MiB';
    throw new Problem(PROBLEM_CODE.tooLarge, message, undefined,
      { reason: { kind: 'validation_error' }, issues: [{ path: 'content', code: 'too_big', message }] });
  }
  return bytes;
}

async function callTool(options: Options, request: Request, claim: CallerClaim, raw: unknown) {
  const call = parseInput(callSchema, raw);
  const args: z.infer<typeof readArgs> & Partial<z.infer<typeof writeArgs>> = call.name === mcpReadTool ? parseInput(readArgs, call.arguments) : parseInput(writeArgs, call.arguments);
  const spec = commands.get(args.command);
  if (!spec || (call.name === mcpReadTool) !== (spec.kind === 'read')) invalid('command', 'Use a command listed for this tool');
  const { opId, restoreId: originalRestore } = args;
  if ((spec.kind === 'write') !== (opId !== undefined))
    invalid('opId', spec.kind === 'write' ? 'opId is required for a saved write' : 'opId is only used for saved writes');
  const headers = new Headers({ 'X-Alpacawork-Client': 'cli', [CONTRACT_HEADER]: String(CLI_CONTRACT), [mcpSourceHeader]: '1' });
  if (claim.run) headers.set('Authorization', `Alpacawork-Run ${claim.run.runId}:${claim.run.token}`);
  if (opId !== undefined) headers.set('X-Alpacawork-Op-Id', opId);
  if (originalRestore !== undefined) headers.set(RESTORE_HEADER, originalRestore);
  const origin = commandOrigin(request, options.publicHost);
  const input = args.input ?? {};
  let target: URL;
  let inputBody: BodyInit | undefined;
  let fileRead: McpFileReadOptions | undefined;
  if (spec.file) {
    const { file, content, contentBase64, offset, length, version, encoding, digest, ...routeInput } = input;
    const base = parseInput(spec.schema, byteInputFromMcp(spec, routeInput)) as Record<string, unknown>;
    const binding = byteRequest(spec.file, base);
    target = new URL(binding.path, origin);
    binding.headers.forEach((value, key) => headers.set(key, value));
    if (spec.file.body === 'bytes') {
      const data = parseInput(inline, { file, content, contentBase64 });
      if ([offset, length, version, encoding, digest].some(value => value !== undefined)) invalid('input', 'Range keys apply only to file reads');
      options.authorizeUpload(claim, String(base.task));
      if (data.file !== undefined) {
        if (!claim.run || request.headers.get(mcpRelayHeader) !== '1' || !isAbsolute(data.file))
          invalid('file', 'Use an absolute path with a Run stdio relay');
        return announced(options.root, { transfer: true });
      }
      const bytes = upload(data);
      headers.set('Content-Type', 'application/octet-stream');
      if (spec.file.contentDigest) headers.set(spec.file.contentDigest, createHash('sha256').update(bytes).digest('hex'));
      inputBody = bytes as BodyInit;
    } else {
      if ([file, content, contentBase64].some(value => value !== undefined)) invalid('input', 'File content applies only to writes');
      fileRead = parseInput(mcpFileReadOptions, { offset, length, version, encoding, digest });
    }
  } else {
    target = new URL(spec.path, origin);
    if (spec.method === 'GET') query(target, input);
    else {
      headers.set('Content-Type', 'application/json');
      inputBody = JSON.stringify(input);
    }
  }
  const response = await options.forward(new Request(target, { method: spec.method, headers, body: inputBody }), fileRead);
  const value: unknown = await response.json();
  if (!response.ok) return errorResult(value);
  if (!fileRead) return announced(options.root, value);
  const file = value as { data: object; image?: { data: string; mimeType: string } };
  const contentParts: Content[] = [text(withIdentity(options.root, file.data))];
  if (file.image) contentParts.push({ type: 'image', ...file.image });
  return { content: contentParts };
}

/** Stateless MCP transport. The raw listener owns Host and Origin before this route is entered. */
export function installMcpRoute(api: Hono, options: Options) {
  api.all(mcpPath, async c => {
    if (!options.enabled) {
      const message = 'MCP is disabled. Enable it with alpacawork setup --mcp on.';
      return rpcError(null, -32000, message, 404);
    }
    if (c.req.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } });
    const request = c.req.raw;
    const version = request.headers.get('MCP-Protocol-Version');
    if (version && !mcpProtocolVersions.some(each => each === version))
      return rpcError(null, -32600, 'Unsupported MCP protocol version', 400);
    let message: z.infer<typeof envelope>;
    let claim: CallerClaim;
    try {
      claim = permittedClaim(options.root, request);
      const raw = await options.readJson(request);
      const parsed = envelope.safeParse(raw);
      if (!parsed.success) return rpcError(null, -32600, 'Invalid JSON-RPC request', 400);
      message = parsed.data;
    } catch (error) {
      const problem = failure(error);
      return rpcError(null, problem.reason?.kind === 'expected_json' ? -32700 : -32000, problem.message, problem.status);
    }
    const { id, params, method } = message;
    if (id === undefined) return new Response(null, { status: 202 });
    if (method === 'initialize') {
      const requested = z.object({ protocolVersion: z.string() }).safeParse(params);
      if (!requested.success) return rpcError(id, -32602, 'protocolVersion is required');
      return rpc(id, { protocolVersion: mcpProtocolVersions.find(each => each === requested.data.protocolVersion) ?? mcpProtocolVersions[0],
        capabilities: { tools: {} }, serverInfo: { name: 'alpacawork', version: options.version },
        instructions: claim.run ? terminalInstructions : coordinatorInstructions });
    }
    if (method === 'ping') return rpc(id, {});
    if (method === 'tools/list') return rpc(id, { tools });
    if (method !== 'tools/call') return rpcError(id, -32601, 'Unknown method');
    try { return rpc(id, await callTool(options, request, claim, params)); }
    catch (error) { return rpc(id, errorResult(errorBody(error))); }
  });
}
