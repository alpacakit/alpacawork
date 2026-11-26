import { basisForRead, workspaceWriteBasis, type WriteBasis } from './connection';
import { canCheckWrite } from "./write-intent";
import { i18n } from "@alpacawork/i18n";
import { z } from "zod";
import { ApiError, createApi } from "./client";
import { coordinatorSnapshotSchema, coordinatorReadAckSchema, coordinatorMessageResponseSchema, coordinatorResetResponseSchema,
  coordinatorTurnsPageSchema, coordinatorMemoSchema, coordinatorMessageStatusSchema, type CoordinatorMessageInput, type CoordinatorSnapshot } from "@alpacawork/contract/coordinator";

export type { CoordinatorTurn, CoordinatorReset, CoordinatorResetReason, CoordinatorTurnsPage, CoordinatorMessageStatus, CoordinatorSnapshot } from "@alpacawork/contract/coordinator";
/**
 * The conversation as this page holds it: serve's, with what this page has learnt of single messages from their own
 * status (a send's, a withdrawal's or a send-now's answer, or a status check), which a snapshot of recent turns may not
 * hold: those withdrawn (`cancelled`), and those serve took (`admitted`): the digest of the input it took, and whether
 * the message's work has ended (one still at work is among the recent turns).
 */
export type CoordinatorConversation = CoordinatorSnapshot['conversation'] & { cancelled: readonly string[];
  admitted: Readonly<Record<string, { digest: string; ended: boolean }>> };
export type CoordinatorMessageResponse = z.infer<typeof coordinatorMessageResponseSchema>;

const api = createApi();
const query = (values: Record<string, string>) => new URLSearchParams(values).toString();
export const readCoordinator = (signal?: AbortSignal) => api.request("coordinator", coordinatorSnapshotSchema, signal);
/** Words answering a fixed question need no Task version. Only an explicit intent promises a versioned operation. */
export function coordinatorWriteBasis(input: { intent?: { task: string }; answers?: { task: string }[] }): WriteBasis {
  const ids = new Set(input.intent ? [input.intent.task] : []);
  return { ...workspaceWriteBasis(), kind: 'all', reads: [...ids].map(id => basisForRead(id)) };
}
export const askCoordinator = (input: CoordinatorMessageInput, basis = coordinatorWriteBasis(input), keepalive = false) => {
  if (!canCheckWrite(basis.root, input.id)) return Promise.reject(new ApiError(() => i18n.t('forms:writeFailure.unproven'), 'write_unavailable', 'fix'));
  return api.request("coordinator/messages", coordinatorMessageResponseSchema, undefined, input, input.id, basis, keepalive);
};
export const clearCoordinator = (conversationId: string) =>
  api.request("coordinator/clear", coordinatorSnapshotSchema, undefined, { conversationId }, undefined, workspaceWriteBasis());
/** Starts the coordinator again from the next message; the same `opId` names the same reset. */
export const resetCoordinator = (conversationId: string, opId: string) =>
  api.request("coordinator/reset", coordinatorResetResponseSchema, undefined, { conversationId, opId }, opId, workspaceWriteBasis());
export const coordinatorMessageAction = (action: "withdraw" | "send-now", conversationId: string, id: string) =>
  api.request(`coordinator/messages/${action}`, coordinatorMessageResponseSchema, undefined, { conversationId, id }, undefined, workspaceWriteBasis());
/** Where one message is now, when an answer that would have said so was lost. */
export const readCoordinatorMessage = (id: string, signal?: AbortSignal) =>
  api.request(`coordinator/messages/${encodeURIComponent(id)}/status`, coordinatorMessageStatusSchema, signal);
/** Turns older than those the snapshot holds, a page at a time: before a turn, or the page around one. */
export const readCoordinatorTurns = (conversationId: string, at: { before: string } | { around: string }, signal?: AbortSignal) =>
  api.request(`coordinator/turns?${query({ conversationId, ...at })}`, coordinatorTurnsPageSchema, signal);
/** The memo a reset handed the new coordinator, as it was then; null when there was none. */
export const readResetMemo = (resetId: string, signal?: AbortSignal) =>
  api.request(`coordinator/resets/${encodeURIComponent(resetId)}/memo`, coordinatorMemoSchema, signal);

export const markCoordinatorSeen = (conversationId: string, seen: string[], keepalive = false) =>
  api.request("coordinator/read", coordinatorReadAckSchema, undefined, { conversationId, seen }, undefined, workspaceWriteBasis(), keepalive);
