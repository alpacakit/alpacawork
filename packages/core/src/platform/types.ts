import type { ServiceDefinition, ServiceObservation } from './service-definition.js';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import type { LibraryHandle } from 'koffi';

type PosixAbi = {
  libc: string;

};

/** One live process incarnation; age is measured by the host, never by wall-clock subtraction in the manager. */
export type RunProcess = { pid: number; parent: number; session: number; started: string; ageMs: number };

export type HostAdapter = {
  posix: PosixAbi;
  isSandboxed(libc: LibraryHandle): boolean;
  /** Native decode only; the caller owns format and container validation. */
  canDecodeImage(absolute: string): boolean;
  run: {
    /**
     * Start a process that leads its own group. With `unit`, the process also leaves serve's service, so stopping
     * or restarting serve does not stop it; the host names it `unit` where it has such a name.
     */
    spawnDetached(command: string, args: readonly string[], options: SpawnOptions, unit?: string): ChildProcess;
    /** True on delivery (or a live probe), false when stopped; refused delivery throws with its cause. */
    signalGroup(pid: number, signal: NodeJS.Signals | 0): boolean;
    /**
     * Stop every process but this one left in the unit `spawnDetached` placed this process in, also those that left
     * its process group, and return once none is left; a process without a unit of its own has none to stop. With
     * `recorded`, the unit is instead the one a process ran in: `scope` is what `scope(pid)` read of it, and only a
     * unit `ours` names (by its name) and this process is not in is stopped, so a recovery stops a lost manager's unit
     * and never its own.
     */
    stopUnitOthers(recorded?: { scope: string; ours: (unit: string) => boolean }): Promise<void>;
    /** What names this boot of the host, as an opaque value: a recorded PID means nothing on another boot. */
    bootId(): string;
    /** The unit process `pid` runs in, as an opaque value `stopUnitOthers` reads; null when it has ended or the host has none. */
    scope(pid: number): string | null;
    /** When process `pid` started, as an opaque value; null when no such process. Tells a reused PID apart. */
    started(pid: number): string | null;
    /** Scope members (except this manager), or the root and its descendants from one ps snapshot. */
    commandProcesses(root: number, scope: string | null): RunProcess[];
    /** Environment names a detached process needs from its caller to place its own children (`unit`). */
    readonly environment: readonly string[];
    /** This user's processes and their command lines: which release a process runs shows in its paths. */
    processes(): { pid: number; command: string }[];
  };
  /** The user's service manager that keeps serve running (systemd user units, launchd agents). */
  service: {
    observe(definition: ServiceDefinition): ServiceObservation;
    /** Called only when the switch has selected its target; registration may start it. */
    register(definition: ServiceDefinition): boolean;
    /** Remove this exact definition after its process stopped; retain all application data. */
    unregister(definition: ServiceDefinition): boolean;
    /** Whether the manager holds `name` to start by itself, as `register` leaves it; false also when the manager cannot be reached. */
    known(name: string): boolean;
    /** Stop `name` and return once it has ended; false when this host cannot stop and wait. */
    stop(service: string | ServiceDefinition): boolean;
    /** Start the saved service without interrupting an already-running instance. */
    start(definition: ServiceDefinition): boolean;
    /** Start `name` again, or start it when stopped; false when the manager refused. */
    restart(service: string | ServiceDefinition): boolean;
    /** How often the manager restarted `name` after it failed; 0 where the host does not count. */
    restarts(name: string): number;
  };
};
