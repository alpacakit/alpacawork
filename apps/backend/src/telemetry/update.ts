/**
 * The detached update executor reports its terminal outcome through the same consent gate. An update is started on the
 * screen, so it counts as the screen's way; which device started it is not known here.
 */
import { TelemetryService } from './service.js';
export async function recordUpdateTelemetry(root: string, ok: boolean): Promise<void> {
  const service = new TelemetryService(root);
  service.mark({ kind: 'event', op: ok ? 'update.ok' : 'update.failed', attributes: { via: 'screen' } });
  await service.close();
}
