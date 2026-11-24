import type { TFunction } from 'i18next';
import type { AgentDraft, AgentDraftIssue } from './agent-settings-draft';

/** Presentation categories only. Contract schemas remain the authority for what is invalid. */
export const AGENT_DRAFT_ISSUE_KINDS = [
  'invalidValue', 'yaml', 'invalidName', 'duplicateAgent', 'invalidKey', 'duplicateKey', 'emptyValue', 'duplicateValue',
  'dashFirst', 'requiredValue', 'unknownVariable', 'unsupportedVariable', 'invalidOptions',
  'missingBase', 'invalidBase', 'invalidEnv', 'duplicateEnv', 'processEnv', 'fixedEnv', 'withoutModel', 'withoutParam', 'withoutDuplicate', 'contextModel', 'contextCompactAt', 'invalidCommand',
] as const;
export type AgentDraftIssueKind = typeof AGENT_DRAFT_ISSUE_KINDS[number];

export function agentDraftIssueKind(issue: AgentDraftIssue): AgentDraftIssueKind {
  const message = issue.message;
  if (issue.field === 'yaml') return 'yaml';
  if (issue.field === 'command') return 'invalidCommand';
  if (message === 'Duplicate agent name') return 'duplicateAgent';
  if (message === 'Duplicate param name') return 'duplicateKey';
  if (message === 'Candidates must be nonblank, trimmed and contain no comma') return 'emptyValue';
  if (message === 'Duplicate candidate') return 'duplicateValue';
  if (message === 'Only the first candidate may be -') return 'dashFirst';
  if (message === 'Required reference needs a nonempty default and cannot start with -') return 'requiredValue';
  if (message === 'Duplicate environment name') return 'duplicateEnv';
  if (message === 'Environment name is owned by the process boundary') return 'processEnv';
  if (message === 'Environment name is owned by the adapter') return 'fixedEnv';
  if (message === 'The compaction point must be below the window') return 'contextCompactAt';
  if (message === 'Unknown model candidate') return issue.field === 'context' ? 'contextModel' : 'withoutModel';
  if (message === 'Duplicate without param') return 'withoutDuplicate';
  if (message === 'without must reference an existing optional param' || message.startsWith('without.')) return 'withoutParam';
  if (message === 'Invalid key in record') return issue.field === 'key' ? 'invalidKey' : issue.field === 'name' ? 'invalidName' : 'invalidValue';
  if (message === 'Alias requires a known built-in adapter' || message === 'A built-in profile name must use its own adapter') return 'invalidName';
  if (issue.field === 'base' && issue.code === 'invalid_type') return 'missingBase';
  if (issue.field === 'base' && issue.code === 'invalid_format') return 'invalidBase';
  if (issue.field === 'env' && issue.code === 'invalid_format') return 'invalidEnv';
  if (message.startsWith('Unknown or reserved variable:')) return 'unknownVariable';
  if (message.startsWith('System variable {')) return 'unsupportedVariable';
  if ((issue.field === 'start' || issue.field === 'resume') && /\(offset \d+\)$/.test(message)) return 'invalidOptions';
  return 'invalidValue';
}

/** A failed candidate parse has no value yet. Do not display checks derived from its placeholder. */
export function agentDraftIssueDependsOnUnreadableParam(issue: AgentDraftIssue, unreadable: ReadonlySet<string>): boolean {
  const [, field, key] = issue.path ?? [];
  const prerequisite = field === 'params' && issue.code !== 'invalid_key' ? key
    : field === 'without' && agentDraftIssueKind(issue) === 'withoutModel' ? 'model' : undefined;
  return typeof prerequisite === 'string' && unreadable.has(prerequisite);
}

/** One translation boundary; callers never render contract messages or internal paths. */
export function agentDraftIssueText(issue: AgentDraftIssue, t: TFunction<'panels'>, agent?: AgentDraft): string {
  const row = agent?.params.find(row => row.id === issue.rowId);
  const name = row?.key ?? (issue.field === 'env' ? agent?.env?.[issue.index ?? Number(issue.path?.[2])] :
    issue.field === 'without' ? String(issue.path?.[2] ?? '') : issue.field === 'key' || issue.field === 'values' ? String(issue.path?.[2] ?? '') : agent?.name) ?? '';
  return t(`agentSettings.errors.${agentDraftIssueKind(issue)}`, { name });
}
