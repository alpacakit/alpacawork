/** Creation-time observations use the same environment boundary as a Run. */
import { AGENT_ADAPTERS, BUILTIN_ADAPTER_IDS, type BuiltinAdapterId } from '@alpacawork/contract/agent-adapters';
import { executableCandidates } from '@alpacawork/core';
import { inspectAgents, type InspectionEnvironment } from '../agents/availability.js';
import type { AgentAvailability } from '@alpacawork/contract';
export type DetectedSetupAgent = AgentAvailability & { id: BuiltinAdapterId };
export async function inspectSetupAgents(environment: InspectionEnvironment): Promise<DetectedSetupAgent[]> {
  const { detected } = await inspectAgents({}, environment);
  return BUILTIN_ADAPTER_IDS.map(id => ({ id, ...detected[id] }))
    .filter(agent => AGENT_ADAPTERS[agent.id].command === null ? agent.status === 'ready' : agent.status !== 'not_found');
}
/** Presence remains useful for skill links independently of sign-in readiness. */
export function detectSetupAgents(cwd: string, env: Readonly<Record<string, string | undefined>>): string[] {
  return BUILTIN_ADAPTER_IDS.filter(id => { const command = AGENT_ADAPTERS[id].command; return command !== null && executableCandidates(command, env.PATH ?? '', cwd).length > 0; });
}
