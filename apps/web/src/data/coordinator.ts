import { basisForRead, workspaceWriteBasis, type WriteBasis } from './connection';
import { canCheckWrite } from "./write-intent";
import { i18n } from "@alpacawork/i18n";
import { ApiError, createApi } from "./client";
import { coordinatorSnapshotSchema, coordinatorReadAckSchema, type CoordinatorMessageInput } from "@alpacawork/contract/coordinator";

export type { CoordinatorConversation, CoordinatorTurn, CoordinatorSnapshot } from "@alpacawork/contract/coordinator";

const api = createApi();
export const readCoordinator = (signal?: AbortSignal) => api.request("coordinator", coordinatorSnapshotSchema, signal);
/** Words answering a fixed question need no Task version. Only an explicit intent promises a versioned operation. */
export function coordinatorWriteBasis(input: { intent?: { task: string }; answers?: { task: string }[] }): WriteBasis {
  const ids = new Set(input.intent ? [input.intent.task] : []);
  return { ...workspaceWriteBasis(), kind: 'all', reads: [...ids].map(id => basisForRead(id)) };
}
export const askCoordinator = (input: CoordinatorMessageInput, basis = coordinatorWriteBasis(input), keepalive = false) => {
  if (!canCheckWrite(basis.root, input.id)) return Promise.reject(new ApiError(() => i18n.t('forms:writeFailure.unproven'), 'write_unavailable', 'fix'));
  return api.request("coordinator/messages", coordinatorSnapshotSchema, undefined, input, input.id, basis, keepalive);
};
export const warmCoordinator = (conversationId: string) =>
  api.request("coordinator/warm", coordinatorSnapshotSchema, undefined, { conversationId }, undefined, workspaceWriteBasis());
export const clearCoordinator = (conversationId: string) =>
  api.request("coordinator/clear", coordinatorSnapshotSchema, undefined, { conversationId }, undefined, workspaceWriteBasis());
export const coordinatorMessageAction = (action: "withdraw" | "send-now", conversationId: string, id: string) =>
  api.request(`coordinator/messages/${action}`, coordinatorSnapshotSchema, undefined, { conversationId, id }, undefined, workspaceWriteBasis());

export const markCoordinatorSeen = (conversationId: string, seen: string[], keepalive = false) =>
  api.request("coordinator/read", coordinatorReadAckSchema, undefined, { conversationId, seen }, undefined, workspaceWriteBasis(), keepalive);
