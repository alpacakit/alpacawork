import { readdir, readFile, realpath } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { gpuCounter, gpuMemory, gpuUtilization } from './gpu.js';
import type { GpuReading } from './host.js';

async function attribute(device: string, name: string): Promise<string> {
  try { return (await readFile(join(device, name), 'utf8')).trim(); }
  catch { return ''; } // Attributes vary by driver and card; removal can race the read.
}

export async function readAmdGpus(drm = '/sys/class/drm'): Promise<GpuReading[]> {
  const cards = (await readdir(drm)).filter(name => /^card\d+$/.test(name))
    .sort((a, b) => Number(a.slice(4)) - Number(b.slice(4)));
  const gpus: GpuReading[] = [];
  // Read one attribute at a time so a stalled driver cannot occupy the Node filesystem pool.
  for (const card of cards) {
    const device = join(drm, card, 'device');
    if (await attribute(device, 'vendor') !== '0x1002') continue;
    const path = await realpath(device).catch(() => null);
    if (path === null) continue;
    const utilization = gpuUtilization(await attribute(device, 'gpu_busy_percent'));
    const used = await attribute(device, 'mem_info_vram_used');
    const total = await attribute(device, 'mem_info_vram_total');
    const memory = gpuMemory(gpuCounter(used), gpuCounter(total));
    if (utilization === null && memory === null) continue;
    const product = await attribute(device, 'product_name');
    gpus.push({ id: `amd:${basename(path)}`, name: product || `AMD GPU (${card})`, utilization, memory, processes: null });
  }
  return gpus;
}
