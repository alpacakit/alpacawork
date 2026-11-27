import { Cron } from 'croner';

/** Croner interprets the same five-field expression for admission, previews and scheduling. */
export function nextAutomationTimes(cron: string, timezone: string, after: Date, count = 1): string[] {
  const expression = cron.trim();
  if (expression.split(/\s+/).length !== 5) throw new Error('Cron requires five fields');
  return new Cron(expression, { timezone }).nextRuns(count, after).map(time => time.toISOString());
}

export function checkAutomationTimezone(timezone: string): void {
  if (!/^[A-Za-z]/.test(timezone)) throw new Error('Use an IANA time zone');
  new Intl.DateTimeFormat('en', { timeZone: timezone });
}
