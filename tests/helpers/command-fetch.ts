/** Fixture helpers take operation identity with the test intent and carry it only in the HTTP header. */
import { randomUUID } from 'node:crypto';
import { commandCatalog } from '@alpacawork/contract/commands';
const mutations = new Set(commandCatalog.commands.filter(command => command.kind === 'write' && !command.file).map(command => command.path));
export const commandHeaders = (input: unknown, headers?: HeadersInit): Headers => {
  const result = new Headers(headers);
  const opId = input && typeof input === 'object' && 'opId' in input ? input.opId : undefined;
  if (!result.has('x-alpacawork-op-id')) result.set('x-alpacawork-op-id', typeof opId === 'string' ? opId : randomUUID());
  return result;
};
export function commandBody(input: unknown, headers?: HeadersInit): unknown {
  if (!input || typeof input !== 'object' || !('opId' in input) || typeof input.opId !== 'string') return input;
  const supplied = new Headers(headers).get('x-alpacawork-op-id');
  if (supplied && supplied !== input.opId) return input;
  const { opId: _identity, ...body } = input;
  return body;
}

export const commandFetchWith = (transport: typeof fetch): typeof fetch => (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  if (init?.method === 'POST' && mutations.has(new URL(url).pathname)) {
    let data: unknown;
    try { data = typeof init.body === 'string' ? JSON.parse(init.body) : undefined; } catch { /* Invalid-body tests remain invalid. */ }
    const body = commandBody(data, init.headers);
    return transport(input, { ...init, ...(body !== data ? { body: JSON.stringify(body) } : {}),
      headers: commandHeaders(data, init.headers) });
  }
  return transport(input, init);
};

export const commandFetch = commandFetchWith(globalThis.fetch);
