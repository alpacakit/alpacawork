/** Coordinator HTTP mutation admission starts after bounded input parsing. */
import type { Hono } from 'hono';
import { coordinatorConversationInputSchema, coordinatorMessageInputSchema, coordinatorReadInputSchema, coordinatorResetInputSchema, coordinatorTurnsInputSchema } from '@alpacawork/contract/coordinator';
import { MAX_FILE_BYTES } from '@alpacawork/contract';
import { fileOpenedResponse, fileRequestOptions } from './file-response.js';
import type { OpenedFile } from '../raw/storage.js';
import type { Mutate } from './lifecycle.js';
import { parseInput, Problem, PROBLEM_CODE } from '@alpacawork/core';
import { CoordinatorConversation } from '../coordinator/conversation.js';
import { withCoordinatorFile, saveCoordinatorAttachment, removeCoordinatorAttachment, moveCoordinatorAttachments } from '../coordinator/files.js';
import { attachmentLimit } from '../agents-settings.js';
import { boundedBytes, requiredOpId } from './file-routes.js';

export function installCoordinatorRoutes(api: Hono, root: string, generation: string, conversation: CoordinatorConversation,
  authorize: (request: Request) => void, mutate: Mutate = async work => work()) {
  const json = async (request: Request) => {
    if (request.headers.get('content-type') !== 'application/json') throw new Problem(PROBLEM_CODE.invalidInput, 'Content-Type must be application/json', undefined, { reason: { kind: 'content_type_must_application_json' } });
    try { return JSON.parse((await boundedBytes(request, 256 * 1024)).toString('utf8')) as Record<string, unknown>; }
    catch (error) { if (error instanceof SyntaxError) throw new Problem(PROBLEM_CODE.invalidInput, 'Expected JSON', undefined, { reason: { kind: 'expected_json' } }); throw error; }
  };
  api.get('/api/coordinator', c => { authorize(c.req.raw); return c.json(conversation.snapshot(generation)); });
  api.get('/api/coordinator/turns', c => {
    authorize(c.req.raw); return c.json(conversation.turns(parseInput(coordinatorTurnsInputSchema, c.req.query())));
  });
  api.get('/api/coordinator/messages/:id/status', c => {
    authorize(c.req.raw); return c.json(conversation.messageStatus(c.req.param('id')));
  });
  api.get('/api/coordinator/resets/:id/memo', c => {
    authorize(c.req.raw); return c.json(conversation.resetMemo(c.req.param('id')));
  });
  api.post('/api/coordinator/reset', async c => {
    authorize(c.req.raw);
    const { conversationId, opId } = parseInput(coordinatorResetInputSchema, await json(c.req.raw));
    return c.json(await mutate(() => {
      const { conversation: view, reset } = conversation.reset(conversationId, opId);
      return { ...conversation.snapshot(generation, view), reset };
    }));
  });
  api.post('/api/coordinator/read', async c => {
    authorize(c.req.raw); const input = parseInput(coordinatorReadInputSchema, await json(c.req.raw));
    return c.json(await mutate(() => conversation.markSeen(input.conversationId, input.seen)));
  });
  api.get('/api/coordinator/skills', async c => {
    authorize(c.req.raw);
    const { conversationId } = parseInput(coordinatorConversationInputSchema, c.req.query());
    return c.json(await conversation.skills(conversationId));
  });
  api.post('/api/coordinator/messages', async c => {
    authorize(c.req.raw); const input = parseInput(coordinatorMessageInputSchema, await json(c.req.raw));
    return c.json(await mutate(() => {
      const view = conversation.ask(input);
      return { ...conversation.snapshot(generation, view), message: conversation.messageStatus(input.id) };
    }));
  });
  for (const action of ['withdraw', 'send-now'] as const) api.post(`/api/coordinator/messages/${action}`, async c => {
    authorize(c.req.raw); const input = await json(c.req.raw);
    if (typeof input.conversationId !== 'string' || typeof input.id !== 'string') throw new Problem(PROBLEM_CODE.invalidInput, 'Conversation and message IDs are required', undefined, { reason: { kind: 'conversation_and_message_ids_required' } });
    const { conversationId, id } = input;
    return c.json(await mutate(() => {
      const view = action === 'withdraw' ? conversation.withdraw(conversationId, id) : conversation.sendNow(conversationId, id);
      return { ...conversation.snapshot(generation, view), message: conversation.messageStatus(id) };
    }));
  });
  api.post('/api/coordinator/clear', async c => {
    authorize(c.req.raw);
    const { conversationId } = parseInput(coordinatorConversationInputSchema, await json(c.req.raw));
    return c.json(conversation.snapshot(generation, await mutate(() => conversation.clear(conversationId))));
  });
  api.post('/api/coordinator/attachments', async c => {
    authorize(c.req.raw); const id = c.req.query('requestId') ?? '';
    const bytes = await boundedBytes(c.req.raw, attachmentLimit(root));
    return c.json(await mutate(() => conversation.attachments(c.req.query('conversationId') ?? '', [id],
      open => saveCoordinatorAttachment(root, open, id, c.req.query('name') ?? '', bytes, requiredOpId(c.req.raw)))));
  });
  api.delete('/api/coordinator/attachments', async c => {
    authorize(c.req.raw); const id = c.req.query('requestId') ?? '';
    return c.json(await mutate(() => conversation.attachments(c.req.query('conversationId') ?? '', [id],
      open => removeCoordinatorAttachment(root, open, id, c.req.query('name') ?? '', requiredOpId(c.req.raw)))));
  });
  api.post('/api/coordinator/attachments/move', async c => {
    authorize(c.req.raw); const input = await json(c.req.raw);
    if (typeof input.conversationId !== 'string' || typeof input.from !== 'string' || typeof input.to !== 'string') throw new Problem(PROBLEM_CODE.invalidInput, 'Attachment move needs request IDs', undefined, { reason: { kind: 'attachment_move_needs_request_ids' } });
    const { conversationId, from, to } = input;
    return c.json(await mutate(() => conversation.attachments(conversationId, [from, to],
      open => moveCoordinatorAttachments(root, open, from, to, requiredOpId(c.req.raw)))));
  });
  api.get('/api/coordinator/file', async c => {
    authorize(c.req.raw);
    const query = new URL(c.req.url).searchParams;
    const id = query.get('requestId') ?? '', name = query.get('name') ?? '';
    const area = query.get('area');
    if (area !== null && area !== 'answers') throw new Problem(PROBLEM_CODE.invalidInput, 'Invalid coordinator file area', undefined, { reason: { kind: 'invalid_coordinator_file_area' } });
    const download = query.get('download');
    if (download !== null && download !== '1') throw new Problem(PROBLEM_CODE.invalidInput, 'download=1 reads the original file');
    const options = fileRequestOptions(c.req.raw, query);
    const respond = (file: OpenedFile) => fileOpenedResponse(name, file, MAX_FILE_BYTES, options);
    return area === 'answers'
      ? conversation.readAnswerFile(id, name, open => withCoordinatorFile(root, open, id, name, area, respond))
      : conversation.readAttachment(id, open => withCoordinatorFile(root, open, id, name, 'attachments', respond));
  });
}
