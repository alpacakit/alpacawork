/** Resource measurement is independent of storage, process control and their supported host ABIs. */
import type { HostMeasurement } from './host.js';
import { linuxHostMeasurement } from './linux-host.js';
import { darwinHostMeasurement } from './darwin-host.js';
import { windowsHostMeasurement } from './windows-host.js';

export function selectHostMeasurement(os: string): (dataDirectory: string) => HostMeasurement {
  switch (os) {
    case 'linux': return linuxHostMeasurement;
    case 'darwin': return darwinHostMeasurement;
    case 'win32': return windowsHostMeasurement;
    default: return () => ({ supported: false, platform: os });
  }
}

/** Chosen once at composition, never in accounting, history, pressure or presentation. */
export const measureHost = selectHostMeasurement(process.platform);
export type { HostFacts, HostReading, HostMeasurement, ProcessStat } from './host.js';
