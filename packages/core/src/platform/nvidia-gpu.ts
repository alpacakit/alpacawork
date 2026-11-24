import { execFile } from 'node:child_process';
import { win32 } from 'node:path';
import { gpuCounter, gpuMemory, gpuUtilization } from './gpu.js';
import type { GpuReading } from './host.js';

const MIB = 1024 ** 2;
const BOARD_QUERY = '--query-gpu=uuid,name,utilization.gpu,memory.used,memory.total';
const PROCESS_QUERY = '--query-compute-apps=gpu_uuid,pid,used_gpu_memory,process_name';
const csvRows = (text: string) => text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
const csvName = (fields: string[]) => fields.join(',').trim().replace(/^"(.*)"$/, (_match, name: string) => name.replaceAll('""', '"'));

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
    gpus.set(id, { id, name, utilization: gpuUtilization(busy), memory: gpuMemory(mibBytes(used), mibBytes(total)), processes: null });
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

function queryNvidia(query: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile('nvidia-smi', [query, '--format=csv,noheader,nounits'], {
      encoding: 'utf8', timeout: 1500, killSignal: 'SIGKILL', maxBuffer: 256 * 1024,
      env: { ...process.env, LC_ALL: 'C' }, windowsHide: true,
    }, (error, stdout) => error ? reject(error) : resolve(stdout));
    child.unref();
  });
}

export async function readNvidiaGpus(processTime: number): Promise<GpuReading[]> {
  const gpus = parseNvidiaGpus(await queryNvidia(BOARD_QUERY));
  if (gpus.length === 0) return gpus;
  try { return withNvidiaProcesses(gpus, await queryNvidia(PROCESS_QUERY), processTime); }
  catch { return gpus; } // Board counters remain usable when the process query is unavailable.
}
