import { performance } from 'node:perf_hooks';
import type { HostSample } from './measure.js';

const REFRESH_MS = 10_000;
const MAX_STALE_MS = 30_000;
const RETRY_MS = 60_000;
type Gpus = HostSample['gpus'];

/** Only a status request can start a probe. Concurrent readers share it. */
export function gpuStatus(probe: () => Promise<Gpus>, clock = () => performance.now()): () => Promise<Gpus> {
  let lastGood: { at: number; gpus: Gpus } | undefined;
  let nextProbeAt = -Infinity;
  let pending: Promise<Gpus> | undefined;
  const visible = (now: number) => lastGood && now - lastGood.at < MAX_STALE_MS ? lastGood.gpus : [];

  return () => {
    if (pending) return pending;
    const now = clock();
    if (now < nextProbeAt) return Promise.resolve(visible(now));

    pending = Promise.resolve().then(probe).catch(() => []).then(gpus => {
      const at = clock();
      if (gpus.length > 0) lastGood = { at, gpus };
      const current = visible(at);
      nextProbeAt = at + (current.length > 0 ? REFRESH_MS : RETRY_MS);
      return current;
    }).finally(() => { pending = undefined; });
    return pending;
  };
}
