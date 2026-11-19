import type { core } from 'zod';
import { redactSecrets } from './redact.js';

/** One wrong input field in the public error envelope. */
export interface Issue {
  readonly path: string;
  readonly code: string;
  readonly message: string;
  readonly params?: Readonly<Record<string, number>>;
}

/** Convert zod's issues into the public wire shape without retaining secrets. */
export function toIssues(issues: readonly core.$ZodIssue[]): Issue[] {
  return issues.map((issue) => {
    const params: Record<string, number> = {};
    if (issue.code === 'too_small') params.minimum = Number(issue.minimum);
    if (issue.code === 'too_big') params.maximum = Number(issue.maximum);
    if (issue.code === 'custom') for (const key of ['minimum', 'maximum', 'line'] as const)
      if (typeof issue.params?.[key] === 'number') params[key] = issue.params[key];
    return {
      path: issue.path.map(String).join('.'),
      code: issue.code === 'custom' && typeof issue.params?.kind === 'string' ? issue.params.kind : issue.code,
      message: redactSecrets(issue.message),
      ...(Object.keys(params).length ? { params } : {}),
    };
  });
}
