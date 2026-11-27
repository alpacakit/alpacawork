import { TASK_ID_PATTERN } from '@alpacawork/contract';
import { firstTaskToken, taskTokens } from '@alpacawork/contract/coordinator';
import { resolveReference } from '@/domain/tasks';

/**
 * The specified wire syntax is independent of the UI language; only selected skill nodes change invocation marker. Task
 * IDs in words are read by the contract's one lexer, the same the server reads them by.
 */
export { formatTask, taskTokens } from '@alpacawork/contract/coordinator';

export const TASK_TRIGGERS = ['#', '＃'] as const;
export const SKILL_TRIGGERS = ['/', '／'] as const;
const taskToken = new RegExp(`^${TASK_ID_PATTERN}$`);
export type MessagePart = { kind: 'text' | 'task' | 'skill' | 'answer' | 'automation'; text: string; id?: string; title?: string };
/** Explicit sent labels use ID format; annotations stay opaque and their words never invent a title. */
export function splitMessage(text: string, skills: ReadonlySet<string> = new Set(), tasks: ReadonlyMap<string, string> = new Map(),
  automations: ReadonlyMap<string, string> = new Map()): MessagePart[] {
  const tokens = new RegExp(String.raw`(?:^|(?<=\s))(${TASK_ID_PATTERN}|[/$][\p{L}\p{N}_][\p{L}\p{N}_:.-]*|[1-9]\d*-[^\s]+)(?=（|\s|$)`, 'gu');
  const parts: MessagePart[] = [];
  const numbers = automationNumbers(text, automations);
  // What follows an automation's number in parentheses is the person's words, whatever it names.
  const opaque = numbers.map(number => [number.from + number.text.length, number.to] as const);
  let end = 0, answers = false;
  let match: RegExpExecArray | null;
  while ((match = tokens.exec(text))) {
    const gap = text.slice(end, match.index);
    let token = match[0];
    if (gap) parts.push({ kind: 'text', text: gap });
    if (gap.trim()) answers = false;
    const within = opaque.find(([from, to]) => from <= match!.index && match!.index < to);
    if (within) {
      parts.push({ kind: 'text', text: text.slice(match.index, within[1]) });
      answers = false;
      end = tokens.lastIndex = within[1];
      continue;
    }
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
  return withAutomations(text, parts, numbers, automations);
}
const automationNumbers = (text: string, automations: ReadonlyMap<string, string>) =>
  taskTokens(text, id => id.startsWith('A') ? { id, title: automations.get(id) ?? '' } : undefined);
/**
 * The automation numbers in a sent message, read over its whole text by the one grammar the input reads with (quotes
 * and code name none): each number is its own part, named as known here (`automations`), never by the words after it,
 * which stay the person's text.
 */
function withAutomations(text: string, parts: MessagePart[], numbers: ReturnType<typeof automationNumbers>,
  automations: ReadonlyMap<string, string>): MessagePart[] {
  if (!numbers.length) return parts;
  const result: MessagePart[] = [];
  let offset = 0;
  for (const part of parts) {
    const start = offset;
    offset += part.text.length;
    if (part.kind !== 'text') { result.push(part); continue; }
    let at = start;
    for (const number of numbers) {
      if (number.from < at || number.from + number.text.length > offset) continue;
      if (number.from > at) result.push({ kind: 'text', text: text.slice(at, number.from) });
      const name = automations.get(number.id);
      result.push({ kind: 'automation', text: number.text, id: number.id, ...(name === undefined ? {} : { title: name }) });
      at = number.from + number.text.length;
    }
    if (at < offset) result.push({ kind: 'text', text: text.slice(at, offset) });
  }
  return result;
}
