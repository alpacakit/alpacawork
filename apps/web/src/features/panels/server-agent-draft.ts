import { z } from 'zod';
import { checkAgentsText, serverFormSchema } from '@alpacawork/contract';
import { readAgentsDraft, validateAgentsDraft, writeAgentsDraft, type AgentsDraft, type DraftResult } from './agent-settings-draft';
import { stackIssues, type StackRowDraft } from './ai-stack-draft';

/**
 * Only the typed agents field is editable. Its source is a read snapshot, never a second text editor. `aiStack` is
 * config.yaml's AI stack, checked against the agents as they are edited, so a row they no longer run is not saved.
 */
export const serverAgentDraftSchema = z.object({
  limits: serverFormSchema.shape.limits,
  // jev: serverFormSchema.shape.jev, // Initial release.
  agents: z.custom<DraftResult<AgentsDraft>>(),
  aiStack: z.custom<StackRowDraft[]>(),
}).superRefine((draft, context) => {
  const issues = draft.agents.ok ? validateAgentsDraft(draft.agents.value) : draft.agents.issues;
  if (issues.length) context.addIssue({ code: 'custom', path: ['agents'], message: 'Invalid agent settings' });
  if (draft.agents.ok && stackIssues(draft.aiStack, draft.agents.value.agents).length)
    context.addIssue({ code: 'custom', path: ['aiStack'], message: 'Invalid AI stack' });
});
export function readServerAgents(source: string): DraftResult<AgentsDraft> {
  // The API owns the YAML envelope and syntax rules; contextual field errors remain editable below.
  const boundary = checkAgentsText(source).issues.filter(issue => issue.kind === 'yaml' || !issue.path);
  if (boundary.length) return { ok: false, issues: boundary.map(issue => ({ field: 'yaml', message: issue.message })) };
  return readAgentsDraft(source, 'agents');
}
export function serverAgentsYaml(draft: Pick<z.infer<typeof serverAgentDraftSchema>, 'agents'>): DraftResult<string> {
  return draft.agents.ok ? writeAgentsDraft(draft.agents.value) : draft.agents;
}
