import { PROBLEM_RULE, type ProblemCode } from "@alpacawork/core/codes";

/** The server's refusal for `code`, with the status and retry its row in the table gives. */
export function problemResponse(code: ProblemCode, message: string = code, detail?: unknown) {
  const { status, retry } = PROBLEM_RULE[code];
  return new Response(JSON.stringify({ error: { code, message, retry, ...(detail === undefined ? {} : { detail }) } }), { status });
}
