import { TelemetryService } from './service.js';
/** One cancellable unref lifetime. A failed pass never interrupts serve or its API. */
export function monitorTelemetry(service: TelemetryService) {
  const cancellation = new AbortController();
  let active: Promise<void> | undefined, timer: ReturnType<typeof setTimeout> | undefined, closed = false;
  const tick = () => {
    active = service.tick(cancellation.signal).catch(error => service.diagnostic(error)).finally(() => {
      active = undefined;
      if (!closed) { timer = setTimeout(tick, 10 * 60_000); timer.unref(); }
    });
  };
  tick();
  return async () => { closed = true; clearTimeout(timer); cancellation.abort(); await active; await service.close(); };
}
