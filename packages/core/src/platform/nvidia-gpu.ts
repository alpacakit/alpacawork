import { execFile } from 'node:child_process';
import { win32 } from 'node:path';
import type { GpuReading, HostGpuReading, ProcessStat } from './host.js';

const MIB = 1024 ** 2;
const BOARD_QUERY = '--query-gpu=uuid,name,utilization.gpu,memory.used,memory.total';
const PROCESS_QUERY = '--query-compute-apps=gpu_uuid,pid,used_gpu_memory,process_name';
const QUERY_TIMEOUT_MS = 1500;
const csvRows = (text: string) => text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
const csvName = (fields: string[]) => fields.join(',').trim().replace(/^"(.*)"$/, (_match, name: string) => name.replaceAll('""', '"'));

function gpuCounter(text: string): number | null {
  const value = Number(text);
  return /^\d+$/.test(text) && Number.isSafeInteger(value) ? value : null;
}

function mibBytes(text: string): number | null {
  const value = gpuCounter(text);
  return value !== null && Number.isSafeInteger(value * MIB) ? value * MIB : null;
}

export function parseNvidiaGpus(text: string): GpuReading[] {
  const gpus = new Map<string, GpuReading>();
  for (const line of csvRows(text)) {
    const fields = line.split(',');
    const id = fields.shift()?.trim();
    if (!id?.startsWith('GPU-') || fields.length < 4) continue;
    const [busy = '', used = '', total = ''] = fields.splice(-3).map(field => field.trim());
    const name = csvName(fields);
    if (!name) continue;
    const percent = gpuCounter(busy);
    const usedBytes = mibBytes(used), totalBytes = mibBytes(total);
    const memory = usedBytes !== null && totalBytes !== null && totalBytes > 0 && usedBytes <= totalBytes ? { usedBytes, totalBytes } : null;
    gpus.set(id, { id, name, utilization: percent !== null && percent <= 100 ? percent : null, memory, processes: null });
  }
  return [...gpus.values()];
}

export function withNvidiaProcesses(gpus: GpuReading[], text: string, since: number): GpuReading[] {
  type Entry = NonNullable<GpuReading['processes']>['entries'][number];
  const entries = new Map(gpus.map(gpu => [gpu.id, new Map<number, Entry>()]));
  const incomplete = new Set<string>();
  for (const line of csvRows(text)) {
    const [uuid = '', pidField = '', memoryField = '', ...nameFields] = line.split(',');
    const id = uuid.trim();
    const byPid = entries.get(id);
    if (!byPid) continue;
    const pid = gpuCounter(pidField.trim()), memoryBytes = mibBytes(memoryField.trim());
    if (pid === null || pid === 0 || memoryBytes === null) {
      incomplete.add(id);
      continue;
    }
    const combined = (byPid.get(pid)?.memoryBytes ?? 0) + memoryBytes;
    if (!Number.isSafeInteger(combined)) {
      incomplete.add(id);
      continue;
    }
    const name = csvName(nameFields);
    byPid.set(pid, { pid, memoryBytes: combined, name: name.startsWith('[') ? String(pid) : win32.basename(name) || String(pid) });
  }
  return gpus.map(gpu => ({ ...gpu, processes: incomplete.has(gpu.id) ? null : { since, entries: [...entries.get(gpu.id)!.values()] } }));
}

export function nvidiaGpuReader(processTime: () => number, readProcesses: () => ReadonlyMap<number, ProcessStat>): () => Promise<HostGpuReading> {
  let running = false;
  function queryNvidia(query: string): Promise<string> {
    if (running) return Promise.reject(new Error('Previous nvidia-smi query has not exited'));
    return new Promise((resolve, reject) => {
      const child = execFile('nvidia-smi', [query, '--format=csv,noheader,nounits'], {
        encoding: 'utf8', timeout: QUERY_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: 256 * 1024,
        env: { ...process.env, LC_ALL: 'C' }, windowsHide: true,
      }, (error, stdout) => {
        running = false;
        clearTimeout(deadline);
        if (error) reject(error);
        else resolve(stdout);
      });
      running = true;
      // Even if a driver prevents the killed process from exiting, release the HTTP request at the deadline.
      const deadline = setTimeout(() => reject(new Error('nvidia-smi query timed out')), QUERY_TIMEOUT_MS);
      child.unref();
    });
  }

  return async () => {
    let gpus = parseNvidiaGpus(await queryNvidia(BOARD_QUERY));
    let processes: ReadonlyMap<number, ProcessStat> = new Map();
    if (gpus.length > 0) {
      try {
        const since = processTime();
        gpus = withNvidiaProcesses(gpus, await queryNvidia(PROCESS_QUERY), since);
        // Snapshot after the GPU query so a reused PID cannot be looked up in an older process list.
        if (gpus.some(gpu => gpu.processes?.entries.length)) processes = readProcesses();
      } catch { /* Board counters and any reported process measurements still apply. */ }
    }
    return { gpus, processes };
  };
}
