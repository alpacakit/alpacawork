import { commandRoute } from '@alpacawork/contract/command-path';
import type { QueryClient } from "@tanstack/react-query";
import type { z } from "zod";
import type { ControlTaskHeadDTO, ProjectedIndexDTO } from "@alpacawork/contract/control";
import { createApi } from "./client";
import { captureReadBoundary, sameReadSession } from './read-model';
import { recordFailure } from '@/lib/notify';
import { showWrittenTask, indexKey } from "./resources";

import type { WriteBasis } from './connection';

const api = createApi();

/** The one browser path for a Task write: send it, then show the committed version. */
export async function writeTask<Result extends { task: ControlTaskHeadDTO }>(
  client: QueryClient, path: string, input: Record<string, unknown>, schema: z.ZodType<Result>, opId: string | undefined, basis: WriteBasis, keepalive = false,
): Promise<Result & { local: 'applied' | 'scope-changed' | 'failed' }> {
  const boundary = captureReadBoundary(client);
  const source = client.getQueryData<ProjectedIndexDTO>(indexKey);
  const result = await api.request(commandRoute(path), schema, undefined, input, opId, basis, keepalive);
  if (!sameReadSession(client, boundary)) return { ...result, local: 'scope-changed' };
  try { showWrittenTask(client, result.task, source); return { ...result, local: 'applied' }; }
  catch (error) { recordFailure(error, 'publish confirmed Task receipt'); return { ...result, local: 'failed' }; }
}

