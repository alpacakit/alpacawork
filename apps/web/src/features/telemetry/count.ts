/**
 * The one way the screen counts a use: each place names what was done with a fixed name (TELEMETRY_OPS). It imports
 * nothing of the data layer, so a write's own admission can count itself; telemetry/data.ts gives it the one sender,
 * which adds the screen's attributes and lets nothing leave the tab before opt-in. The server adds each use to the
 * day's local marks, which go out only inside the next day's report.
 */
import type { TelemetryOp, TelemetryTime } from '@alpacawork/contract/telemetry';
import type { OpenDialog } from '@/state/dialog-store';

export type UseFact = { op: TelemetryOp } | { time: TelemetryTime; ms: number };
let sender: ((fact: UseFact) => void) | null = null;
export function sendUsesWith(send: (fact: UseFact) => void): void { sender = send; }
export function countUse(op: TelemetryOp | null | undefined): void { if (op) sender?.({ op }); }
/** A measured time: how long the screen took, in milliseconds. */
export function countTime(time: TelemetryTime, ms: number): void { if (Number.isFinite(ms) && ms >= 0 && ms <= 60_000) sender?.({ time, ms }); }
/** A time that starts at one place and ends at another (opening a task → its content shown); a newer start replaces it. */
const started = new Map<TelemetryTime, { key: string; at: number }>();
export function startTime(time: TelemetryTime, key: string): void { started.set(time, { key, at: performance.now() }); }
/**
 * A time only measures the screen while it is waited for: out of sight (a tab behind) drops what was started, and the
 * page's opening is not measured once it was hidden or the person already did something (another first screen).
 */
let pageOpened = typeof document !== 'undefined' && document.visibilityState !== 'visible';
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => { if (document.visibilityState !== 'visible') { pageOpened = true; started.clear(); } });
  for (const kind of ['pointerdown', 'keydown'] as const) document.addEventListener(kind, () => { pageOpened = true; }, { capture: true, once: true });
}
/** The page's opening: from loading it to its list's first rows. */
export function countPageOpened(): void {
  if (pageOpened) return;
  pageOpened = true;
  countTime('open', performance.now());
}
export function endTime(time: TelemetryTime, key: string): void {
  const start = started.get(time);
  if (start?.key !== key) return;
  started.delete(time);
  countTime(time, performance.now() - start.at);
}

const DIALOG_USES = { settings: 'open.settings', diagnostics: 'open.diagnostics', project: 'open.project', run: null, intro: null } as const;
const FORM_USES = { report: 'form.report', responsible: 'form.responsible', move: 'form.move' } as const;
/** The use a change of the one open dialog counts: a newly opened kind (or input form); a tab moved within is not one. */
export function dialogUse(dialog: OpenDialog | null, previous: OpenDialog | null): TelemetryOp | null {
  if (!dialog || dialog.kind === previous?.kind && (dialog.kind !== 'input' || previous.kind === 'input' && dialog.form === previous.form)) return null;
  return dialog.kind === 'input' ? FORM_USES[dialog.form] : DIALOG_USES[dialog.kind];
}
