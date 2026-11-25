/** Screen adapters authorize before reading input; TelemetryService owns every local fact. */
import type { Hono } from 'hono';
import { z } from 'zod';
import { Problem, PROBLEM_CODE, parseInput } from '@alpacawork/core';
import { telemetryScreenUseSchemaOf, telemetryTimeSchema, TELEMETRY_EVENT_ATTRIBUTES } from '@alpacawork/contract/telemetry';
import { boundedBytes } from '../receiver/file-routes.js';
import type { TelemetryService } from './service.js';

const choiceInput = z.object({ choice: z.enum(['on', 'off']), expectedDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
// One use with the screen's own attributes, or one measured time (a minute at most: anything longer is not a screen waiting).
const useInput = z.union([telemetryScreenUseSchemaOf(TELEMETRY_EVENT_ATTRIBUTES),
  z.object({ time: telemetryTimeSchema, ms: z.number().min(0).max(60_000) }).strict()]);

async function json(request: Request): Promise<unknown> {
  if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json')
    throw new Problem(PROBLEM_CODE.invalidInput, 'Content-Type must be application/json', undefined,
      { reason: { kind: 'content_type_must_application_json' } });
  try { return JSON.parse((await boundedBytes(request, 1024)).toString('utf8')); }
  catch (error) {
    if (error instanceof SyntaxError) throw new Problem(PROBLEM_CODE.invalidInput, 'Expected JSON', undefined,
      { reason: { kind: 'expected_json' } });
    throw error;
  }
}

export function installTelemetryRoutes(api: Hono, service: TelemetryService, requirePerson: (request: Request) => void): void {
  api.get('/api/telemetry/status', async c => { requirePerson(c.req.raw); return c.json(await service.status()); });
  api.get('/api/telemetry/history', c => {
    requirePerson(c.req.raw);
    c.header('Cache-Control', 'no-store');
    return c.json(service.history());
  });
  api.get('/api/telemetry/preview', c => { requirePerson(c.req.raw); return c.json({ state: service.gate().state, next: service.preview() }); });
  api.post('/api/telemetry/choice', async c => {
    requirePerson(c.req.raw);
    const input = parseInput(choiceInput, await json(c.req.raw));
    return c.json(await service.choose(input.choice, 'screen', input.expectedDigest));
  });
  api.post('/api/telemetry/use', async c => {
    requirePerson(c.req.raw);
    const input = parseInput(useInput, await json(c.req.raw));
    service.mark('op' in input ? { kind: 'event', op: input.op, attributes: input.attributes } : { kind: 'time', time: input.time, ms: input.ms });
    return c.json({ ok: true });
  });
  // Deleting what was sent is a person's choice from Settings, whether or not sending is on now.
  api.post('/api/telemetry/delete', async c => {
    requirePerson(c.req.raw);
    parseInput(z.object({}).strict(), await json(c.req.raw));
    return c.json(await service.deleteSent());
  });
}
