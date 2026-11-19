import { z } from 'zod';
import { checkAgentsText, serverFormSchema } from '@alpacawork/contract';
import { readAgentsDraft, validateAgentsDraft, writeAgentsDraft, type AgentsDraft, type DraftResult } from './agent-settings-draft';

/** Only the typed agents field is editable. Its source is a read snapshot, never a second text editor. */
export const serverAgentDraftSchema = z.object({
  limits: serverFormSchema.shape.limits,
  // jev: serverFormSchema.shape.jev, // Initial release.
  agents: z.custom<DraftResult<AgentsDraft>>(),
}).superRefine((draft, context) => {
  const issues = draft.agents.ok ? validateAgentsDraft(draft.agents.value) : draft.agents.issues;
  if (issues.length) context.addIssue({ code: 'custom', path: ['agents'], message: 'Invalid agent settings' });
});
export function readServerAgents(source: string): DraftResult<AgentsDraft> {
  // The API owns the YAML envelope and syntax rules; contextual field errors remain editable below.
  const boundary = checkAgentsText(source).issues.filter(issue => issue.kind === 'yaml' || !issue.path);
  if (boundary.length) return { ok: false, issues: boundary.map(issue => ({ field: 'yaml', message: issue.message })) };
  return readAgentsDraft(source, 'agents');
}
export function serverAgentsYaml(draft: z.infer<typeof serverAgentDraftSchema>): DraftResult<string> {
  return draft.agents.ok ? writeAgentsDraft(draft.agents.value) : draft.agents;
}
