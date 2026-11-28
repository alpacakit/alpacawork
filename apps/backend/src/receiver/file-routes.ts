/**
 * HTTP adapter for Task file bytes. The server authorizes each request (a read as a read of its Task, a write as
 * file.write before its bytes are read, and again by the grant it returns in the transaction that reserves the write)
 * and invalidates caches. A route takes only its own query parameters.
 */
import { BYTE_HEADERS, fileBytesResponse, fileOpenedResponse, fileRequestOptions, SANDBOX, fileResponsePlan } from './file-response.js';
import type { Mutate } from './lifecycle.js';
import type { Hono } from 'hono';
import { closeSync, readSync } from 'node:fs';
import { fileKind, fileStreams } from '@alpacawork/contract';
import { byteBinding } from '@alpacawork/contract/commands';
import { taskIdSchema } from '@alpacawork/contract';
import { taskFileInput } from '@alpacawork/contract/inputs';
import { reportDiffHead } from '@alpacawork/contract/report-diff';
import { Problem, PROBLEM_CODE, parseInput } from '@alpacawork/core';
import { requirePublished, FileJournal, fileDigest, type WriteGrant } from '../control/file-journal.js';
import { attachmentLimit, fileTooLarge } from '../agents-settings.js';
import { codeRoots, readCodeBytes, readCodeFile } from '../control/code-files.js';
import { openTaskFile, saveTaskAttachment } from '../control/task-files.js';
import { readOpenedFile } from '../raw/storage.js';

export async function boundedBytes(request: Request, limit: number): Promise<Buffer> {
  const declared=Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared>limit) throw fileTooLarge(limit);
  const chunks: Buffer[]=[]; let size=0;
  for await (const chunk of request.body ?? []) {
    const bytes=Buffer.from(chunk); size+=bytes.length;
    if (size>limit) throw fileTooLarge(limit);
    chunks.push(bytes);
  }
  return Buffer.concat(chunks,size);
}

/**
 * The query parameters of a request, when it sends only those its route takes: any other (an old `?project=` among
 * them) is refused, never read past.
 */
function queryOf(request: Request, allowed: readonly string[]): URLSearchParams {
  const query = new URL(request.url).searchParams;
  const unknown = [...new Set(query.keys())].filter(key => !allowed.includes(key));
  if (unknown.length) throw new Problem(PROBLEM_CODE.invalidInput, `Unknown query parameter: ${unknown.join(', ')}`, undefined,
    { reason: { kind: 'unknown_query_parameter', unknown: String(unknown.join(', ')) }, issues: unknown.map(key => ({ path: key, code: 'unrecognized_keys', message: `${key} is not taken here` })) });
  return query;
}

/** The client's operation ID a mutation needs. A route asks at the point its refusals are ordered: PUT before the body, an attachment after it. */
export function requiredOpId(request: Request): string {
  const value = request.headers.get('X-Alpacawork-Op-Id');
  if (!value?.trim()) throw new Problem(PROBLEM_CODE.invalidInput, 'Operation ID is required', undefined, { reason: { kind: 'operation_id_required' } });
  return value;
}

type FileRouteOptions = {
  /** Refuses a read of the Task's files, or allows it. */
  authorizeRead: (request: Request, task: string) => void | Promise<void>;
  /**
   * Refuses a write of the Task's files before its bytes are read, or returns the grant the write is authorized by
   * again where it is reserved.
   */
  authorizeWrite: (request: Request, task: string) => WriteGrant | Promise<WriteGrant>;
  mcpRead?: (request: Request, task: string, path: string) => Promise<unknown> | undefined;
  changed: (task: string) => void | Promise<void>;
  mutate?: Mutate;
  links?: (request: Request, value: unknown) => unknown;
};

export function installTaskFileRoutes(api: Hono, root: string, options: FileRouteOptions) {
  const mutate: Mutate = options.mutate ?? (async work => work());
  const journal = new FileJournal(root);
  journal.recover();
  const downloadFile = byteBinding('task/file/get');
  api.on(downloadFile.method, downloadFile.path, async c => {
    // `v` is the revision a reader adds so that a changed file is read again.
    // `part=head`: a diff file's report header alone (reportDiffHead), what its summary reads without the patch's rows.
    const query = queryOf(c.req.raw, [...downloadFile.query!, 'frame', 'v', 'part', 'download']);
    const { task, name } = parseInput(taskFileInput,
      { task: c.req.param('task'), name: query.get('path') ?? '' });
    await options.authorizeRead(c.req.raw, task);
    const mcpRead = options.mcpRead?.(c.req.raw, task, name);
    if (mcpRead) return c.json(await mcpRead, 200);
    const download = query.get('download');
    if (download !== null && (download !== '1' || query.has('frame') || query.has('part')))
      throw new Problem(PROBLEM_CODE.invalidInput, 'download=1 reads the original file without frame or part');
    const part = query.get('part');
    if (part !== null && (part !== 'head' || fileKind(name) !== 'diff'))
      throw new Problem(PROBLEM_CODE.invalidInput, 'part=head is taken for a diff file only', undefined,
        { reason: { kind: 'unknown_query_parameter', unknown: 'part' }, issues: [{ path: 'part', code: 'invalid_value', message: 'part=head is taken for a diff file only' }] });
    const request = fileRequestOptions(c.req.raw, query);
    // Media and explicit original downloads stream at any size; the attachment limit bounds documents read whole.
    if (fileStreams(name) || download === '1') {
      const { fd, size, revision } = await openTaskFile(root, task, name);
      const { start, end, status, hasBody, headers } = fileResponsePlan(name, size, { ...request, revision, supportsRanges: true });
      if (!hasBody) { closeSync(fd); return c.body(null, status, headers); }
      let position = start, closed = false;
      const close = () => { if (!closed) { closed = true; closeSync(fd); } };
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          try {
            const bytes = Buffer.allocUnsafe(Math.min(64 * 1024, end - position + 1));
            const count = readSync(fd, bytes, 0, bytes.length, position);
            position += count;
            const finished = !count || position > end;
            if (count) controller.enqueue(bytes.subarray(0, count));
            if (finished) { close(); controller.close(); }
          } catch (error) { close(); controller.error(error); }
        },
        cancel: close,
      });
      return new Response(stream, { status, headers });
    }
    const limit = attachmentLimit(root);
    try {
      return journal.withTaskFile(task, name, file => {
        const frame = name.toLowerCase().endsWith('.html') && query.get('frame') === '1';
        if (!frame && part === null) return fileOpenedResponse(name, file, limit, request);
        const text = new TextDecoder().decode(readOpenedFile(file.fd, file.size, limit));
        if (frame) return c.body(new TextEncoder().encode(FRAME_SCRIPT + text), 200, {
          'Content-Type': 'text/html; charset=utf-8', ...BYTE_HEADERS,
          'Content-Security-Policy': "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
            "img-src data:; font-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
        });
        return c.body(reportDiffHead(text), 200, { 'Content-Type': 'text/plain; charset=utf-8', ...BYTE_HEADERS,
          'Content-Security-Policy': SANDBOX });
      });
    } catch (error) {
      throw error instanceof Problem && error.code === PROBLEM_CODE.tooLarge ? fileTooLarge(limit) : error;
    }
  });
  // A file of the Task's code locations its words name (code-files.ts), read only; and those places, for the screen to
  // know which paths it may offer to open. `download=1`: the same file, refused alike, saved as stored under its name.
  api.get('/api/tasks/:task/code', async c => {
    const query = queryOf(c.req.raw, ['path', 'download']);
    const task = parseInput(taskFileInput, { task: c.req.param('task'), name: 'code' }).task;
    await options.authorizeRead(c.req.raw, task);
    const path = query.get('path') ?? '', download = query.get('download');
    if (download !== null && download !== '1') throw new Problem(PROBLEM_CODE.invalidInput, 'download=1 saves the original file');
    if (download) return fileBytesResponse(path, readCodeBytes(root, task, path), { download: true });
    return c.body(readCodeFile(root, task, path), 200, { 'Content-Type': 'text/plain; charset=utf-8', ...BYTE_HEADERS,
      'Content-Security-Policy': SANDBOX });
  });
  api.get('/api/tasks/:task/code-roots', async c => {
    queryOf(c.req.raw, []);
    const task = parseInput(taskFileInput, { task: c.req.param('task'), name: 'code' }).task;
    await options.authorizeRead(c.req.raw, task);
    return c.json({ roots: codeRoots(root, task) }, 200, BYTE_HEADERS);
  });
  const uploadFile = byteBinding('task/file/put');
  api.on(uploadFile.method, uploadFile.path, async c => {
    const { task, name } = parseInput(taskFileInput,
      { task: c.req.param('task'), name: queryOf(c.req.raw, uploadFile.query!).get('path') ?? '' });
    const grant = await options.authorizeWrite(c.req.raw, task);
    const opId = requiredOpId(c.req.raw);
    const bytes = await boundedBytes(c.req.raw, attachmentLimit(root));
    const digest = fileDigest(bytes);
    if (c.req.header(uploadFile.contentDigest!) !== digest)
      throw new Problem(PROBLEM_CODE.invalidInput, 'Content digest differs', undefined, { reason: { kind: 'content_digest_differs' } });
    const expectedDigest = c.req.header(uploadFile.headers!.expectedDigest!);
    if (expectedDigest !== undefined && !/^[0-9a-f]{64}$/.test(expectedDigest))
      throw new Problem(PROBLEM_CODE.invalidInput, 'Invalid expected digest', undefined, { reason: { kind: 'invalid_expected_digest' } });
    const result = { path: name, bytes: bytes.length, digest };
    const outcome = await mutate(() => journal.putTaskFile({ task, name, opId, bytes, expectedDigest, result, grant }));
    requirePublished(outcome);
    await options.changed(task);
    return c.json(outcome.body, outcome.status as 200);
  });
}

const FRAME_SCRIPT = `<script>(()=>{try{localStorage}catch(e){const m=new Map();Object.defineProperty(window,"localStorage",{configurable:true,` +
  `value:{getItem:(k)=>m.has(k)?m.get(k):null,setItem:(k,v)=>{m.set(k,String(v))},removeItem:(k)=>{m.delete(k)},clear:()=>m.clear()}});}` +
  `const size=()=>parent.postMessage({alpacaworkFrame:1,height:document.documentElement.scrollHeight},"*");` +
  `addEventListener("load",size);addEventListener("DOMContentLoaded",()=>new ResizeObserver(size).observe(document.body));})();</script>`;

/** Install in place of the old attachment routes so every mutation has a client operation ID. */
export function installAttachmentFileRoutes(api: Hono, root: string, options: FileRouteOptions) {
  const mutate: Mutate = options.mutate ?? (async work => work());
  const uploadAttachment = byteBinding('task/attachment/put');
  api.on(uploadAttachment.method, uploadAttachment.path, async c => {
    const task = parseInput(taskIdSchema, c.req.param('task')), query = queryOf(c.req.raw, uploadAttachment.query!);
    const grant=await options.authorizeWrite(c.req.raw,task);
    const bytes = await boundedBytes(c.req.raw,attachmentLimit(root));
    const result=await mutate(() => saveTaskAttachment(root,task,query.get('requestId') ?? '',
      query.get('name') ?? '',bytes,requiredOpId(c.req.raw),grant));
    await options.changed(task);
    return c.json(options.links?.(c.req.raw, result) ?? result, 200);
  });
}
