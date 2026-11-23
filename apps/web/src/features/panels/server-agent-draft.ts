import { z } from 'zod';
import { checkAgentsText, serverFormSchema } from '@alpacawork/contract';
import { readAgentsDraft, validateAgentsDraft, writeAgentsDraft, type AgentsDraft, type DraftResult } from './agent-settings-draft';
import { stackIssues, type StackRowDraft } from './ai-stack-draft';

/** The draft's two stacks, by the list each edits (AiStack's `kind`). */
export const STACK_FIELDS = ['aiStack', 'coordinatorAiStack'] as const;
export type StackField = typeof STACK_FIELDS[number];
export const stackKind = (field: StackField) => field === 'aiStack' ? 'tasks' as const : 'coordinator' as const;

/**
 * Only the typed agents field is editable. Its source is a read snapshot, never a second text editor. `aiStack` and
 * `coordinatorAiStack` are config.yaml's two AI stacks (tasks', the input's), each checked against the agents as they
 * are edited, so a row they no longer run is not saved.
 */
export const serverAgentDraftSchema = z.object({
  limits: serverFormSchema.shape.limits,
  // jev: serverFormSchema.shape.jev, // Initial release.
  agents: z.custom<DraftResult<AgentsDraft>>(),
  aiStack: z.custom<StackRowDraft[]>(),
  coordinatorAiStack: z.custom<StackRowDraft[]>(),
}).superRefine((draft, context) => {
  const issues = draft.agents.ok ? validateAgentsDraft(draft.agents.value) : draft.agents.issues;
  if (issues.length) context.addIssue({ code: 'custom', path: ['agents'], message: 'Invalid agent settings' });
  for (const stack of STACK_FIELDS)
    if (draft.agents.ok && stackIssues(draft[stack], draft.agents.value.agents).length)
      context.addIssue({ code: 'custom', path: [stack], message: 'Invalid AI stack' });
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
