/** Domain fixtures keep built-in settings and route any accidental launch to an inert local executable. */
import { AGENTS_TEMPLATE } from '@alpacawork/backend/test-dist/agents-settings.js';
import { installAgentStub } from './agent-stub.ts';
export function inertAgentTemplate(root: string) {
  process.env.PATH = installAgentStub(root, 'claude');
  return AGENTS_TEMPLATE;
}
