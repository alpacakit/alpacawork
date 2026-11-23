/** The setup screen's state and offered skills with their installation. */
import { codecs, defineEntry, defineEntryEndpoint, defineEntryNode, defineParameter, required } from '@alpacakit/channels';
import { bindHttpEntry } from '@alpacakit/channels/http';
import { z } from 'zod';
import { firstRunRequestSchema, firstRunResponseSchema, skillsResponseSchema, skillInstallResponseSchema } from '@alpacawork/contract';
import { Problem, PROBLEM_CODE, parseInput } from '@alpacawork/core';
import { SCREEN, withAct } from '../entries.js';
import type { Context } from './entries.js';

function screenEndpoint(name: string, method: 'GET' | 'POST', fields: string[], work: (input: unknown, context: Context) => unknown) {
  const entry = defineEntry({ name, parameters: fields.map(name => defineParameter({ name, description: name,
    requirement: required(), codec: codecs.define({ schema: z.json(), shape: { kind: 'string' } }) })), project: ({ values }) => values });
  return withAct(defineEntryEndpoint(entry, { handler: work, channels: [bindHttpEntry({ method })] }), SCREEN);
}
function need<T>(value: T | undefined): T {
  if (value === undefined) throw new Problem(PROBLEM_CODE.unavailable, 'Setup is not available here');
  return value;
}
export const firstRunNodes = [
  defineEntryNode({ name: 'first-run', description: 'Setup of a new workspace', endpoints: [
    screenEndpoint('first-run', 'GET', [], (_input, context) => firstRunResponseSchema.parse(need(context.firstRun).get())),
    screenEndpoint('first-run', 'POST', ['change'], async (input, context) =>
      firstRunResponseSchema.parse(await need(context.firstRun).change(parseInput(firstRunRequestSchema, input).change))),
  ] }),
  defineEntryNode({ name: 'skills', description: 'Offered skills and installation progress', endpoints: [
    screenEndpoint('skills', 'GET', [], async (_input, context) => skillsResponseSchema.parse(await need(context.skills).status())),
  ], children: [defineEntryNode({ name: 'install', description: 'Install selected offered skills', endpoints: [
    screenEndpoint('install', 'POST', ['names'], (input, context) => skillInstallResponseSchema.parse(need(context.skills).install(input, context.opId))),
  ] })] }),
];
