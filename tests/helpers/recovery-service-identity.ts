/** Read-only observation of the recovery fixture service's sole PID/starttick record. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

type Identity = { pid: number; starttick: string; cwd: string };
export type RecoveryServiceObservation =
  | { state: 'live' | 'exited' | 'reused'; identity: Identity; actualStarttick?: string }
  | { state: 'missing' | 'unreadable' | 'invalid'; cause: unknown };

export function observeRecoveryService(base: string): RecoveryServiceObservation {
  let identity: Identity;
  let raw: string;
  try { raw = readFileSync(join(base, 'serve.identity.json'), 'utf8'); }
  catch (cause) { return { state: (cause as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable', cause }; }
  try {
    const value = JSON.parse(raw);
    if (!Number.isSafeInteger(value.pid) || value.pid <= 0 || typeof value.starttick !== 'string' || !/^\d+$/.test(value.starttick) || typeof value.cwd !== 'string' || !value.cwd.startsWith('/'))
      throw new Error('Invalid recovery service identity');
    identity = value;
  } catch (cause) { return { state: 'invalid', cause }; }
  let stat: string;
  try { stat = readFileSync('/proc/' + identity.pid + '/stat', 'utf8'); }
  catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'exited', identity };
    return { state: 'unreadable', cause };
  }
  const fields = stat.slice(stat.lastIndexOf(') ') + 2).split(' '), actualStarttick = fields[19];
  if (!actualStarttick || !/^\d+$/.test(actualStarttick)) return { state: 'invalid', cause: new Error('Invalid process identity observation') };
  if (actualStarttick !== identity.starttick) return { state: 'reused', identity, actualStarttick };
  return { state: ['Z', 'X'].includes(fields[0]!) ? 'exited' : 'live', identity };
}

/** IW1 may shorten its deadline only after proving that the recorded child exited. */
export function recoveryServiceRestarts(base: string, record: (observation: RecoveryServiceObservation) => void): number {
  const observation = observeRecoveryService(base);
  record(observation);
  if (observation.state === 'live') return 0;
  if (observation.state === 'exited') return 1;
  throw new Error('Cannot establish recovery service death: ' + observation.state,
    { cause: 'cause' in observation ? observation.cause : observation });
}
