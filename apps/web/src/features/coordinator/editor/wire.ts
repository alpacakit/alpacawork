import { TASK_ID_PATTERN } from '@alpacawork/contract';
import { firstTaskToken } from '@alpacawork/contract/coordinator';
import { resolveReference } from '@/domain/tasks';

/**
 * The specified wire syntax is independent of the UI language; only selected skill nodes change invocation marker. Task
 * IDs in words are read by the contract's one lexer, the same the server reads them by.
 */
export { formatTask, taskTokens } from '@alpacawork/contract/coordinator';

export const TASK_TRIGGERS = ['#', '＃'] as const;
export const SKILL_TRIGGERS = ['/', '／'] as const;
const taskToken = new RegExp(`^${TASK_ID_PATTERN}$`);
export type MessagePart = { kind: 'text' | 'task' | 'skill' | 'answer'; text: string; id?: string; title?: string };
/** Explicit sent labels use ID format; annotations stay opaque and their words never invent a title. */
export function splitMessage(text: string, skills: ReadonlySet<string> = new Set(), tasks: ReadonlyMap<string, string> = new Map()): MessagePart[] {
  const tokens = new RegExp(String.raw`(?:^|(?<=\s))(${TASK_ID_PATTERN}|[/$][\p{L}\p{N}_][\p{L}\p{N}_:.-]*|[1-9]\d*-[^\s]+)(?=（|\s|$)`, 'gu');
  const parts: MessagePart[] = [];
  let end = 0, answers = false;
  let match: RegExpExecArray | null;
  while ((match = tokens.exec(text))) {
    const gap = text.slice(end, match.index);
    let token = match[0];
    if (gap) parts.push({ kind: 'text', text: gap });
    if (gap.trim()) answers = false;
    if (taskToken.test(token)) {
      const id = token;
      const known = tasks.get(id);
      const reference = resolveReference(id);
      if (reference) {
        if (text[match.index + token.length] === '（') {
          // Reuse the input's annotation parser, including complete known titles with closing parentheses inside.
          const annotated = firstTaskToken(text.slice(match.index), taskId => {
            const target = resolveReference(taskId);
            return target && { ...target, title: tasks.get(taskId) ?? '' };
          });
          if (annotated?.from === 0) token = text.slice(match.index, match.index + annotated.to);
        }
        parts.push({ kind: 'task', text: token, id: reference.id, ...(known === undefined ? {} : { title: known }) });
        answers = true;
      } else { parts.push({ kind: 'text', text: token }); answers = false; }
    } else if (answers && /^[1-9]\d*-/.test(token)) parts.push({ kind: 'answer', text: token });
    else { parts.push({ kind: skills.has(token.slice(1)) && /^[/$]/.test(token) ? 'skill' : 'text', text: token }); answers = false; }
    end = match.index + token.length;
    tokens.lastIndex = end;
  }
  if (end < text.length) parts.push({ kind: 'text', text: text.slice(end) });
  return parts;
}
