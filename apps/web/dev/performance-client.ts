/// <reference types="vite/client" />
import { ENDPOINT, INTERVAL_MS, SEND_DEADLINE_MS, MAX_CONTEXT_EVENTS, emptyMetrics, type Sample, type Action } from '../../backend/src/diagnostics/protocol.ts';
import { inputAction, screenContext } from './performance-context.ts';
import { freshDetails, addInput, addRender, addResource, resourceCategory } from './performance-details.ts';
import { createLifecycle } from './performance-lifecycle.ts';

type Fiber = { tag: number; flags: number; type?: { name?: string; type?: { name?: string }; render?: { name?: string } };
  actualDuration?: number; child?: Fiber; sibling?: Fiber; alternate?: Fiber };
type Hook = { supportsFiber: boolean; isDisabled?: boolean; renderers: Map<number, unknown>; inject: (renderer: unknown) => number;
  onCommitFiberRoot?: (...args: any[]) => void; onCommitFiberUnmount?: () => void; checkDCE?: () => void };
declare global { interface Window { __REACT_DEVTOOLS_GLOBAL_HOOK__?: Hook } }

/** Only development or explicit diagnostic HTML imports this module. No app stores, props, text, URLs or Fiber roots are retained. */
export function startPerformance(options: { buildId: string; componentNames: boolean }) {
  let failed = false;
  const lifecycle = createLifecycle(document.visibilityState);
  const lifeVisibility = () => lifecycle.visibility(document.visibilityState);
  const lifePagehide = () => lifecycle.pagehide();
  const lifeResume = () => lifecycle.returned('resume');
  // Page-lifetime observation survives pagehide for BFCache; permanent failure/dispose removes it.
  document.addEventListener('visibilitychange', lifeVisibility);
  document.addEventListener('resume', lifeResume);
  window.addEventListener('pagehide', lifePagehide);
  function start(buffered = true) {
    const tab = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const started = performance.now(), observers: PerformanceObserver[] = [], components = new Map<string, number>();
    const supported: Sample['supported'] = { reactCommits: false, reactRender: false, componentNames: options.componentNames, longtask: false, longFrame: false, resource: false, heap: false, eventTiming: false, renderPhases: false };
    let details = freshDetails(supported);
    const fresh = () => ({ ...emptyMetrics(), reactRenderMs: null, componentRenders: options.componentNames ? 0 : null });
    let metrics: Sample['metrics'] = fresh(), since = performance.now(), lastFrame = 0, scrollUntil = 0, frame = 0;
    let live = true, sending: AbortController | undefined, warned = false;
    let context: Sample['context'] = { atStart: screenContext(), atSample: ['unknown'], events: [], dropped: 0 };
    const visible = () => live && document.visibilityState === 'visible';
    const reset = () => { metrics = fresh(); details = freshDetails(supported); components.clear(); since = performance.now();
      context = { atStart: screenContext(), atSample: ['unknown'], events: [], dropped: 0 }; };
    const record = (kind: Action) => {
      if (!visible()) return;
      if (context.events.length === MAX_CONTEXT_EVENTS) {
        context.dropped = Math.min(1e12, context.dropped + 1);
        if (kind === 'scroll') return;
        context.events.shift();
      }
      context.events.push({ atMs: Math.max(0, performance.now() - since), kind, screen: screenContext() });
    };
    const input = (event: Event) => { if (visible()) { const kind = inputAction(event); if (kind) record(kind); } };
    const hook: Hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__ ??= {
      supportsFiber: true, renderers: new Map(), inject(renderer) { const id = this.renderers.size + 1; this.renderers.set(id, renderer); return id; },
      checkDCE() {}, onCommitFiberUnmount() {},
    };
    const previous = hook.onCommitFiberRoot;
    const commit: Hook['onCommitFiberRoot'] = function (...args) {
      previous?.apply(hook, args);
      if (!visible()) return;
      metrics.reactCommits++;
      const root = args[1]?.current as Fiber | undefined;
      if (typeof root?.actualDuration === 'number' && Number.isFinite(root.actualDuration) && root.actualDuration >= 0) {
        supported.reactRender = true; metrics.reactRenderMs = (metrics.reactRenderMs ?? 0) + root.actualDuration;
      }
      const walk = (fiber?: Fiber) => {
        if (!fiber) return;
        if ([0, 1, 11, 14, 15].includes(fiber.tag) && (!fiber.alternate || (fiber.flags & 1))) {
          metrics.componentRenders = (metrics.componentRenders ?? 0) + 1;
          const name = fiber.type?.name ?? fiber.type?.type?.name ?? fiber.type?.render?.name;
          if (name && /^[A-Za-z_$][\w.$-]{0,63}$/.test(name) && (components.has(name) || components.size < 100))
            components.set(name, (components.get(name) ?? 0) + 1);
        }
        if (fiber.alternate && fiber.alternate.child === fiber.child) return;
        for (let child = fiber.child; child; child = child.sibling) walk(child);
      };
      if (options.componentNames) walk(root);
    };
    if (!hook.isDisabled) { hook.onCommitFiberRoot = commit; supported.reactCommits = true; }

    function observe(type: string, receive: (entry: PerformanceEntry) => void, durationThreshold?: number) {
      if (typeof PerformanceObserver === 'undefined' || !PerformanceObserver.supportedEntryTypes.includes(type)) return false;
      const observer = new PerformanceObserver(list => { if (visible()) for (const entry of list.getEntries()) receive(entry); });
      try { observer.observe({ type, buffered, ...durationThreshold === undefined ? {} : { durationThreshold } }); }
      catch { observer.disconnect(); return false; }
      observers.push(observer); return true;
    }
    supported.longtask = observe('longtask', entry => {
      metrics.longTasks++; metrics.longTaskMs += entry.duration; metrics.maxLongTaskMs = Math.max(metrics.maxLongTaskMs, entry.duration);
    });
    supported.longFrame = observe('long-animation-frame', entry => {
      metrics.longFrames++; metrics.longFrameMs += entry.duration;
      metrics.blockingMs += (entry as PerformanceEntry & { blockingDuration: number }).blockingDuration;
      addRender(details, entry);
    });
    supported.resource = observe('resource', entry => {
      const resource = entry as PerformanceResourceTiming, category = resourceCategory(resource);
      if (!category) return;
      metrics.resources++; metrics.resourceMs += entry.duration; metrics.maxResourceMs = Math.max(metrics.maxResourceMs, entry.duration);
      metrics.transferBytes += (entry as PerformanceResourceTiming).transferSize;
      addResource(details, category, resource);
    });
    supported.eventTiming = observe('event', entry => addInput(details, entry), 16);
    const loaf = (globalThis as typeof globalThis & { PerformanceLongAnimationFrameTiming?: { prototype: object } }).PerformanceLongAnimationFrameTiming;
    supported.renderPhases = supported.longFrame && !!loaf && 'renderStart' in loaf.prototype && 'styleAndLayoutStart' in loaf.prototype;
    details = freshDetails(supported);
    function tick(now: number) {
      if (visible() && lastFrame) {
        const gap = now - lastFrame; metrics.frames++; metrics.frameMs += gap; metrics.maxFrameMs = Math.max(metrics.maxFrameMs, gap);
        // 2ms tolerance avoids treating normal 60Hz clock jitter as missed frames. This is an rAF estimate, not compositor FPS.
        if (gap > 1000 / 60 + 2) { metrics.framesOverBudget++; if (now < scrollUntil) metrics.scrollFramesOverBudget++; }
      }
      lastFrame = now; frame = requestAnimationFrame(tick);
    }
    const scroll = () => { if (visible()) { metrics.scrolls++; scrollUntil = performance.now() + 200; record('scroll'); } };
    const visibility = () => {
      reset(); lastFrame = 0; cancelAnimationFrame(frame); clearInterval(timer);
      if (visible()) { frame = requestAnimationFrame(tick); timer = setInterval(send, INTERVAL_MS); }
    };
    document.addEventListener('scroll', scroll, { passive: true, capture: true });
    document.addEventListener('visibilitychange', visibility);
    document.addEventListener('resume', visibility);
    document.addEventListener('click', input, true);
    document.addEventListener('input', input, true);
    frame = requestAnimationFrame(tick);
    const send = async () => {
      if (!visible()) return;
      const now = performance.now(), wall = Date.now(); metrics.visibleMs = now - since;
      metrics.fps = metrics.frameMs ? metrics.frames * 1000 / metrics.frameMs : 0;
      const elements = document.querySelectorAll('*'); metrics.domElements = elements.length;
      for (const element of elements) {
        if (element.localName === 'li' && element.hasAttribute('data-row')) details.dom.rows++;
        if (element.localName === 'li' && element.hasAttribute('data-report-key')) details.dom.reports++;
      }
      details.dom.viewportWidth = window.innerWidth; details.dom.viewportHeight = window.innerHeight;
      const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
      supported.heap = !!memory; metrics.heapBytes = memory?.usedJSHeapSize ?? 0;
      context.atSample = screenContext();
      const sample: Sample = { buildId: options.buildId, tab, sinceMs: now - started, metrics, context, details, lifecycle: lifecycle.sample(now, wall), supported: { ...supported }, components: [...components]
        .sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, renders]) => ({ name, renders })) };
      reset();
      if (sending) return; // A failed receiver never creates an offline send queue.
      lifecycle.sent(now, wall);
      sending = new AbortController(); const timeout = setTimeout(() => sending?.abort(), SEND_DEADLINE_MS);
      try {
        const response = await fetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'omit',
          body: JSON.stringify(sample), signal: sending.signal });
        if (!response.ok) throw new Error('receiver');
      } catch {
        if (live && !warned) { warned = true; failed = true; stop(); removeLifecycleListeners(); console.warn('[performance] receiver unavailable; recording stopped until reload'); }
      } finally { clearTimeout(timeout); sending = undefined; }
    };
    let timer = setInterval(send, INTERVAL_MS);
    const stop = () => {
      if (!live) return;
      live = false; clearInterval(timer); cancelAnimationFrame(frame); sending?.abort(); observers.forEach(observer => observer.disconnect());
      document.removeEventListener('scroll', scroll, true); document.removeEventListener('visibilitychange', visibility);
      document.removeEventListener('resume', visibility);
      document.removeEventListener('click', input, true); document.removeEventListener('input', input, true);
      window.removeEventListener('pagehide', stop);
      if (hook.onCommitFiberRoot === commit) hook.onCommitFiberRoot = previous;
    };
    window.addEventListener('pagehide', stop);
    return stop;
  }
  let stop = start();
  const resume = (event: PageTransitionEvent) => { if (event.persisted && !failed) { lifecycle.returned('pageshow-persisted'); stop(); stop = start(false); } };
  window.addEventListener('pageshow', resume);
  function removeLifecycleListeners() {
    document.removeEventListener('visibilitychange', lifeVisibility); document.removeEventListener('resume', lifeResume);
    window.removeEventListener('pagehide', lifePagehide); window.removeEventListener('pageshow', resume);
  }
  const dispose = () => { stop(); removeLifecycleListeners(); };
  import.meta.hot?.dispose(dispose);
  return dispose;
}
