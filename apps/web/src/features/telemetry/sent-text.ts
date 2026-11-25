/**
 * What was sent, laid out to read: one key per line, and each row of a list of rows (the counted actions) on one line,
 * instead of one value per line. Only spacing changes; a body that is not JSON is shown as it was sent.
 */
export function sentText(body: string): string {
  let value: unknown;
  try { value = JSON.parse(body); } catch { return body; }
  return layout(value, '');
}

function layout(value: unknown, indent: string): string {
  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    if (value.every(item => !isObject(item) || Array.isArray(item) && item.every(cell => !isObject(cell))))
      return value.every(item => !isObject(item)) ? JSON.stringify(value)
        : `[\n${value.map(item => `${indent}  ${JSON.stringify(item)}`).join(',\n')}\n${indent}]`;
    return `[\n${value.map(item => `${indent}  ${layout(item, `${indent}  `)}`).join(',\n')}\n${indent}]`;
  }
  if (isObject(value)) {
    const entries = Object.entries(value);
    if (!entries.length) return '{}';
    return `{\n${entries.map(([key, item]) => `${indent}  ${JSON.stringify(key)}: ${layout(item, `${indent}  `)}`).join(',\n')}\n${indent}}`;
  }
  return JSON.stringify(value);
}

function isObject(value: unknown): value is object { return typeof value === 'object' && value !== null; }

/**
 * The attempts that will be sent again: for each day still waiting to be sent, its newest attempt (the log is newest
 * first). Older attempts of that day, and days no longer waiting, are not sent again.
 */
export function willResend<T extends { kind: string; day?: string }>(log: readonly T[], waiting: ReadonlySet<string>): ReadonlySet<T> {
  const seen = new Set<string>(), again = new Set<T>();
  for (const entry of log) {
    if (entry.kind !== 'report' || entry.day === undefined || seen.has(entry.day)) continue;
    seen.add(entry.day);
    if (waiting.has(entry.day)) again.add(entry);
  }
  return again;
}
