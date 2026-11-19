/** This user's PC consent writes XDG state, even while the workspace is read-only.
 * Keep the server's restore pin and human/origin checks; consent's digest owns concurrency. Deleting what was sent
 * goes the same way. */
import { RESTORE_HEADER } from '@alpacawork/contract/recovery';
import { problemSchema } from '@alpacawork/contract/problem';
import { z } from 'zod';
import { telemetryIdSchema, telemetryStatusSchema, type TelemetryStatus } from '@alpacawork/contract/telemetry';
import { ApiError, apiError } from '@/data/client';
import { writeRestoreId } from '@/data/connection';
import { withRequestActivity } from '@/data/request-activity';

export function saveTelemetryChoice(root: string, choice: 'on' | 'off', expectedDigest: string | null): Promise<TelemetryStatus> {
  return post(root, 'choice', { choice, expectedDigest }, telemetryStatusSchema);
}
/** Asks the receiver to delete every report sent with this PC's number. */
export function deleteSentTelemetry(root: string): Promise<{ id: string }> {
  return post(root, 'delete', {}, z.object({ id: telemetryIdSchema }));
}
function post<T>(root: string, path: 'choice' | 'delete', body: object, schema: z.ZodType<T>): Promise<T> {
  return withRequestActivity(async () => {
    const restored = writeRestoreId(root);
    if (!restored) throw new ApiError('Cannot identify the server for usage data consent', 'restore_changed', 'fix');
    let response: Response;
    try {
      response = await fetch(`/api/telemetry/${path}`, {
        method: 'POST', signal: AbortSignal.timeout(20_000),
        headers: { 'Content-Type': 'application/json', [RESTORE_HEADER]: restored, 'X-Alpacawork-Op-Id': crypto.randomUUID() },
        body: JSON.stringify(body),
      });
    } catch (cause) { throw Object.assign(new ApiError('Usage data consent response was lost', 'network_error', 'check'), { cause }); }
    const answer: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const problem = problemSchema.safeParse(answer);
      if (problem.success) throw apiError(problem.data.error);
      throw new ApiError(`HTTP ${response.status}`, 'http_error', 'check', { status: response.status });
    }
    const saved = schema.safeParse(answer);
    if (!saved.success) throw new ApiError('Invalid usage data consent response', 'invalid_response', 'check');
    return saved.data;
  });
}
