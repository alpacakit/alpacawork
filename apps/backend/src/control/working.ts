/** The Tasks with their own unfinished execution. Returns and incoming Requests are not Runs. */
export function workingOf(records: readonly { task: string; state: string }[] | null): string[] | null {
  return records === null ? null : [...new Set(records.filter(run =>
    run.state === 'queued' || run.state === 'running' || run.state === 'needs_review').map(run => run.task))];
}
