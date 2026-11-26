import { Problem, PROBLEM_CODE } from '@alpacawork/core';

export const SKILL_INVOCATIONS = { claude: '/', codex: '$' } as const;

/** Skill chips are serialized as complete words in the message body. */
export function assertSkillInvocations(adapter: string, text: string, skills: readonly string[]): void {
  const invocation = Object.hasOwn(SKILL_INVOCATIONS, adapter) ? SKILL_INVOCATIONS[adapter as keyof typeof SKILL_INVOCATIONS] : undefined;
  const words = new Set(text.split(/\s+/u));
  if (!invocation || skills.some(name => !words.has(invocation + name)))
    throw new Problem(PROBLEM_CODE.conflict, 'The message uses a different skill invocation than the selected coordinator. Check the skills and send it again.',
      undefined, { reason: { kind: 'skill_invocation_mismatch' } });
}
