/**
 * How often serve and each Run's manager look again for what no notification reports: a stop or an input for a
 * running agent, a Run's progress, a pass that is due. A stop, an input and a screen update wait up to this long.
 * Rules measured in time (grace, timeouts, rests) stay in milliseconds and do not count these looks.
 */
export const POLL_INTERVAL_MS = 500;
