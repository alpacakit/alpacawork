import { commandPath, commandRoute } from '@alpacawork/contract/command-path';
import { withRequestActivity } from './request-activity';
import { beforeRestoreOperationSchema, unknownAfterRestoreOperationSchema } from '@alpacawork/contract/recovery';
import { basisForRead, useConnection, writeAccess, type WriteBasis } from '@/data/connection';
import { mutationHeaders, continuingMutationHeaders, requireWriteAccess } from './client';
import { i18n } from "@alpacawork/i18n";
import { problemSchema } from "@alpacawork/contract/problem";
import { attachmentResultSchema, type AttachmentResult } from "@alpacawork/contract/control";
import { z } from "zod";
import { attachmentsPath, taskFileRoute } from "@alpacawork/contract/task-file-route";
import { ApiError, apiError } from "./client";
import { api } from "./resources";
import type { Attachment } from "@/domain/attachments";

export type AttachmentDestination = { kind: "task"; taskId: string } | { kind: "coordinator"; conversationId: string };
/** A Task's attachments are under its file route; the coordinator's in its conversation. */
const base = (destination: AttachmentDestination) => destination.kind === "task"
  ? attachmentsPath.replace(':task', encodeURIComponent(destination.taskId)) : "/api/coordinator/attachments";
/** What a write here is checked against: the Task's own read, or the workspace for the coordinator's. */
const destinationBasis = (destination: AttachmentDestination) => basisForRead(destination.kind === "task" ? destination.taskId : undefined);
/** One attachment's query: a request's file, in the coordinator's conversation too. */
const fileQuery = (destination: AttachmentDestination, requestId: string, name: string) =>
  `${destination.kind === "coordinator" ? `conversationId=${encodeURIComponent(destination.conversationId)}&` : ""}requestId=${encodeURIComponent(requestId)}&name=${encodeURIComponent(name)}`;
export const attachmentFileUrl = (destination: AttachmentDestination, path: string) => destination.kind === "task"
  ? taskFileRoute(destination.taskId, path)
  : `/api/coordinator/file?requestId=${encodeURIComponent(path.split("/")[1] ?? "")}&name=${encodeURIComponent(path.split("/")[2] ?? "")}`;


/** Keep the workspace-relative link in drafts and instructions after checking the receipt names the expected file. */
export function attachmentFromResult(destination: AttachmentDestination, result: AttachmentResult): Attachment | null {
  const path = attachmentFileUrl(destination, result.path);
  const link = new URL(result.absolutePath, 'http://local.invalid');
  return link.pathname + link.search === path && !link.hash
    ? { ...result, absolutePath: path, name: result.path.split('/').at(-1)! }
    : null;
}

const attachmentOperationSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("committed"), status: z.number(), body: attachmentResultSchema }).strict(),
  z.object({ state: z.enum(["pending", "needs_review", "not_found"]) }).strict(),
  beforeRestoreOperationSchema, unknownAfterRestoreOperationSchema,
]);

export type AttachmentOperation = z.infer<typeof attachmentOperationSchema>;

/** Read the receipt of an upload whose browser reply was lost, without sending its bytes again. */
export function getAttachmentOperation(opId: string) {
  return api.request(`${commandRoute('operation/get')}?opId=${encodeURIComponent(opId)}`, attachmentOperationSchema);
}

/** What a refused attachment write says: the server's problem when it sent one, else its HTTP status. */
const attachmentRefusal = (body: unknown, status: number) => {
  const problem = problemSchema.safeParse(body);
  return problem.success ? apiError(problem.data.error) : new ApiError(`HTTP ${status}`, "http_error");
};

/**
 * Save one file under the task's `attachments/` folder. XHR rather than fetch: only it reports upload progress
 * (0–1). The server names the file (it may shorten or clean the name) and answers where it put it.
 */
export function uploadAttachment(destination: AttachmentDestination, requestId: string, file: File, name: string, progress: (done: number) => void, signal: AbortSignal, opId: string): Promise<Attachment> {
  const basis = destinationBasis(destination);
  const ready = waitForUploadAccess(basis, signal);
  const send = () => sendAttachment(destination, requestId, file, name, progress, signal, opId, basis);
  return ready ? ready.then(send) : send();
}

/** The device picker can return while the foreground visit is still checking its connection.
 * Keep the selected bytes in the draft, and wait before the first send; never bypass write authority. */
function waitForUploadAccess(basis: WriteBasis, signal: AbortSignal): Promise<void> | null {
  if (writeAccess(basis) !== 'offline' && !signal.aborted) return null;
  return new Promise((resolve, reject) => {
    const clean = () => { stop(); clearTimeout(timer); signal.removeEventListener('abort', abort); };
    const abort = () => { clean(); reject(new DOMException('Aborted', 'AbortError')); };
    const check = () => {
      if (writeAccess(basis) === 'offline') return;
      clean();
      try { requireWriteAccess(basis); resolve(); } catch (error) { reject(error); }
    };
    const stop = useConnection.subscribe(check);
    const timer = setTimeout(() => { clean(); reject(new ApiError(() => i18n.t('workspace.networkError'), 'write_unavailable', 'later')); }, 20_000);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort(); else check();
  });
}

function sendAttachment(destination: AttachmentDestination, requestId: string, file: File, name: string, progress: (done: number) => void, signal: AbortSignal, opId: string, basis: WriteBasis): Promise<Attachment> {
  return withRequestActivity(() => new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", `${base(destination)}?${fileQuery(destination, requestId, name)}`);
    const headers=mutationHeaders(basis,opId,{"Content-Type":"application/octet-stream"});
    headers.forEach((value,name)=>request.setRequestHeader(name,value));
    request.upload.onprogress = (event) => { if (event.lengthComputable) progress(event.loaded / event.total); };
    request.onload = () => {
      let body: unknown = null;
      try { body = JSON.parse(request.responseText); } catch { /* answered below */ }
      if (request.status >= 200 && request.status < 300) {
        const parsed = attachmentResultSchema.safeParse(body);
        const saved = parsed.success ? attachmentFromResult(destination, parsed.data) : null;
        if (saved) resolve(saved);
        else reject(new ApiError(() => i18n.t("workspace.invalidResponse"), "invalid_response"));
        return;
      }
      reject(attachmentRefusal(body, request.status));
    };
    request.onerror = () => reject(new ApiError(() => i18n.t("workspace.networkError")));
    request.onabort = () => reject(new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", () => request.abort(), { once: true });
    if (signal.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
    requireWriteAccess(basis);
    request.send(file);
  }));
}

/** No answer to a write: it may have landed (the same as api.request's). */
const unanswered = (cause: unknown) => { throw Object.assign(new ApiError(() => i18n.t("workspace.networkError")), { cause }); };

/** The person's click admits the removal, even when the upload's final filename arrives later. */
export function admitAttachmentRemoval(destination: AttachmentDestination): string {
  const opId = crypto.randomUUID();
  mutationHeaders(destinationBasis(destination), opId);
  return opId;
}

export async function removeAttachment(destination: AttachmentDestination, requestId: string, name: string, opId: string): Promise<void> {
  return withRequestActivity(async () => {
    const headers = continuingMutationHeaders(destinationBasis(destination), opId);
    const response = await (destination.kind === "task"
      ? fetch(commandPath('task/attachment/remove'), {
        method: "POST", headers: new Headers([...headers, ['Content-Type', 'application/json']]),
        body: JSON.stringify({ task: destination.taskId, requestId, name }),
      })
      : fetch(`${base(destination)}?${fileQuery(destination, requestId, name)}`, { method: "DELETE", headers })).catch(unanswered);
    if (response.ok) return;
    throw attachmentRefusal(await response.json().catch(() => null), response.status);
  });
}
