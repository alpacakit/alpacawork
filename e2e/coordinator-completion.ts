import { coordinatorSnapshotSchema, coordinatorMessageInputSchema, coordinatorMessageStatusSchema, coordinatorTurnsPageSchema, type CoordinatorTurn } from '@alpacawork/contract/coordinator';
import type { Page, Request } from '@playwright/test';
import { until } from '../tests/acceptance/processes.ts';
import type { Runtime } from './server.ts';

/** Register before the UI action; a response from another message cannot satisfy its readiness. */
export const coordinatorMessage = (page: Page) => page.waitForRequest(request =>
  request.method() === 'POST' && new URL(request.url()).pathname === '/api/coordinator/messages');

/**
 * Agent execution and result rendering have separate deadlines. This waits for this accepted message's
 * real, imported answer; callers retain their ordinary UI assertions after it. Spool files are not receipts.
 */
export async function coordinatorCompleted(page: Page, runtime: Runtime, request: Request, timeout = 30_000): Promise<CoordinatorTurn> {
  const deadline = performance.now() + timeout;
  const input = coordinatorMessageInputSchema.parse(request.postDataJSON());
  const identity = `${input.conversationId}/${input.id}`;
  const remaining = () => {
    const left = Math.ceil(deadline - performance.now());
    if (left <= 0) throw new Error(`Deadline: coordinator ${identity} completes`);
    return left;
  };
  let observed = 'awaiting admission';
  try {
    let admissionTimer: ReturnType<typeof setTimeout> | undefined;
    let response: Awaited<ReturnType<Request['response']>>;
    try {
      response = await Promise.race([request.response(), new Promise<never>((_, reject) => {
        admissionTimer = setTimeout(() => reject(new Error(`Deadline: coordinator ${identity} admission`)), remaining());
      })]);
    } finally { clearTimeout(admissionTimer); }
    if (!response?.ok()) throw new Error(`Message was not accepted: ${response?.status() ?? 'no response'}`);
    observed = 'not observed';
    return await until(async () => {
      const reply = await page.request.get(runtime.origin + '/api/coordinator', { timeout: remaining() });
      if (!reply.ok()) throw new Error(`Coordinator read failed: ${reply.status()}`);
      const conversation = coordinatorSnapshotSchema.parse(await reply.json()).conversation;
      remaining();
      if (conversation.id !== input.conversationId) throw new Error(`Conversation changed: ${conversation.id}`);
      let turn = conversation.turns.find(turn => turn.id === input.id);
      if (!turn) {
        const response = await page.request.get(`${runtime.origin}/api/coordinator/messages/${input.id}/status`, { timeout: remaining() });
        if (!response.ok()) throw new Error(`Coordinator status read failed: ${response.status()}`);
        const { status } = coordinatorMessageStatusSchema.parse(await response.json());
        if (status === 'withdrawn' || status === 'failed') throw new Error(`Message is ${status}`);
        if (status === 'succeeded') {
          const query = new URLSearchParams({ conversationId: conversation.id, around: input.id });
          const response = await page.request.get(`${runtime.origin}/api/coordinator/turns?${query}`, { timeout: remaining() });
          if (!response.ok()) throw new Error(`Coordinator history read failed: ${response.status()}`);
          turn = coordinatorTurnsPageSchema.parse(await response.json()).turns.find(turn => turn.id === input.id);
        }
      }
      observed = turn ? JSON.stringify({ status: turn.status, answer: turn.answer !== null, error: turn.error, into: turn.into }) : 'message absent';
      if (turn?.status === 'failed') throw new Error(`Message failed: ${observed}`);
      return turn?.status === 'succeeded' && turn.answer !== null && turn.answeredAt !== null ? turn : false;
    }, `coordinator ${identity} completes`, remaining());
  } catch (cause) {
    throw new Error(`Coordinator ${identity}: ${observed}`, { cause });
  }
}
