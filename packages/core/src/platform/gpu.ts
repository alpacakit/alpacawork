import { performance } from 'node:perf_hooks';
import type { GpuReading } from './host.js';

export function gpuCounter(text: string): number | null {
  const value = Number(text);
  return /^\d+$/.test(text) && Number.isSafeInteger(value) ? value : null;
}

export function gpuUtilization(text: string): number | null {
  const value = gpuCounter(text);
  return value !== null && value <= 100 ? value : null;
}

export function gpuMemory(usedBytes: number | null, totalBytes: number | null): GpuReading['memory'] {
  return usedBytes !== null && totalBytes !== null && totalBytes > 0 && usedBytes <= totalBytes ? { usedBytes, totalBytes } : null;
}

/** A host sample takes a completed GPU reading without waiting and starts the next probe. */
export function pollGpus(probe: (processTime: number) => Promise<GpuReading[]>): (processTime: number) => GpuReading[] {
  let completed: { gpus: GpuReading[]; started: number } | undefined;
  let pending = false, retryAt = 0;
  return processTime => {
    const now = performance.now();
    // Normal samples are 10 seconds apart. A suspended sampler must not publish an old probe.
    const gpus = completed && now - completed.started < 20_000 ? completed.gpus : [];
    completed = undefined;
    if (!pending && now >= retryAt) {
      pending = true;
      void Promise.resolve().then(() => probe(processTime)).then(
        gpus => {
          completed = { gpus, started: now };
          if (gpus.length === 0) retryAt = performance.now() + 60_000;
        },
        () => { retryAt = performance.now() + 60_000; },
      ).finally(() => { pending = false; });
    }
    return gpus;
  };
}
