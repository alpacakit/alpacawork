import { afterEach, expect, test, vi } from 'vitest';

afterEach(() => { window.dispatchEvent(new Event('pagehide')); document.body.innerHTML = ''; delete window.__REACT_DEVTOOLS_GLOBAL_HOOK__; vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

test('development collector sends bounded numerical windows, preserves another React hook and stops on pagehide', async () => {
  vi.useFakeTimers(); vi.resetModules();
  const prior = vi.fn();
  const hook = { supportsFiber: true, renderers: new Map(), inject: () => 1, onCommitFiberRoot: prior };
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = hook;
  const fetch = vi.fn().mockResolvedValue({ ok: true }); vi.stubGlobal('fetch', fetch);
  const disconnect = vi.fn();
  const observe = vi.fn();
  vi.stubGlobal('PerformanceObserver', class { static supportedEntryTypes = ['resource', 'longtask']; observe = observe; disconnect = disconnect; });
  let raf: FrameRequestCallback = () => {};
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { raf = callback; return 1; });
  const cancel = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  const { startPerformance } = await import('../dev/performance-client');
  const dispose = startPerformance({ buildId: 'development', componentNames: true });
  expect(observe.mock.calls.map(([options]) => options.buffered)).toEqual([true, true]);
  hook.onCommitFiberRoot(1, { current: { tag: 0, flags: 1, actualDuration: 5, type: { name: 'Workspace' }, memoizedProps: { text: 'PRIVATE' } } });
  raf(4780); raf(4800);
  await vi.advanceTimersByTimeAsync(5000);
  expect(prior).toHaveBeenCalledOnce(); expect(fetch).toHaveBeenCalledOnce();
  const sample = JSON.parse(fetch.mock.calls[0]![1].body);
  expect(sample.metrics.reactCommits).toBe(1); expect(sample.metrics.componentRenders).toBe(1);
  expect(sample.components).toEqual([{ name: 'Workspace', renders: 1 }]);
  expect(JSON.stringify(sample)).not.toContain('PRIVATE');
  // Timer runs before the next rAF: the 300ms gap across a send must survive in the next window.
  raf(5100); await vi.advanceTimersByTimeAsync(5000);
  expect(JSON.parse(fetch.mock.calls[1]![1].body).metrics.maxFrameMs).toBe(300);
  window.dispatchEvent(new Event('pagehide'));
  expect(hook.onCommitFiberRoot).toBe(prior); expect(disconnect).toHaveBeenCalledTimes(2); expect(cancel).toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(10000); expect(fetch).toHaveBeenCalledTimes(2);
  window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  // A restored page must observe new work only, rather than replay its previous long tasks/resources.
  expect(observe.mock.calls.map(([options]) => options.buffered)).toEqual([true, true, false, false]);
  await vi.advanceTimersByTimeAsync(5000); expect(fetch).toHaveBeenCalledTimes(3);
  expect(hook.onCommitFiberRoot).not.toBe(prior);
  dispose();
});


test.each(['http', 'timeout'])('first %s failure stops collection across BFCache until reload', async failure => {
  vi.useFakeTimers(); vi.resetModules();
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  const fetch = vi.fn(failure === 'http' ? () => Promise.resolve({ ok: false })
    : (_url: unknown, options: { signal: AbortSignal; body: string }) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('timeout')))));
  vi.stubGlobal('fetch', fetch);
  const { startPerformance } = await import('../dev/performance-client');
  const dispose = startPerformance({ buildId: 'a'.repeat(40) + '-diagnostic', componentNames: false });
  await vi.advanceTimersByTimeAsync(26000);
  window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
  window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  await vi.advanceTimersByTimeAsync(20000);
  expect(fetch).toHaveBeenCalledTimes(1);
  const sample = JSON.parse(fetch.mock.calls[0]![1].body as string);
  expect(sample.metrics.reactRenderMs).toBeNull(); expect(sample.metrics.componentRenders).toBeNull();
  expect(sample.supported.componentNames).toBe(false); expect(sample.components).toEqual([]);
  dispose();
});

test('returning to visibility starts a full five-second window', async () => {
  vi.useFakeTimers(); vi.resetModules();
  const state = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  const fetch = vi.fn().mockResolvedValue({ ok: true }); vi.stubGlobal('fetch', fetch);
  const { startPerformance } = await import('../dev/performance-client');
  const dispose = startPerformance({ buildId: 'development', componentNames: true });
  await vi.advanceTimersByTimeAsync(4000); state.mockReturnValue('hidden'); document.dispatchEvent(new Event('visibilitychange'));
  await vi.advanceTimersByTimeAsync(500); state.mockReturnValue('visible'); document.dispatchEvent(new Event('visibilitychange'));
  await vi.advanceTimersByTimeAsync(500); expect(fetch).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(4500); expect(fetch).toHaveBeenCalledTimes(1);
  expect(JSON.parse(fetch.mock.calls[0]![1].body).metrics.visibleMs).toBe(5000);
  dispose();
});

test('context captures pre-handler intent and sample DOM, bounds events, drops secrets and removes listeners', async () => {
  vi.useFakeTimers(); vi.resetModules();
  const state = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  const fetch = vi.fn().mockResolvedValue({ ok: true }); vi.stubGlobal('fetch', fetch);
  document.body.innerHTML = `<div data-result-list><button data-result="TSECRET" aria-label="SECRET label">SECRET title</button></div>`;
  const { startPerformance } = await import('../dev/performance-client');
  const { readSample, MAX_CONTEXT_EVENTS } = await import('../../backend/src/diagnostics/protocol');
  const dispose = startPerformance({ buildId: 'a'.repeat(40) + '-diagnostic', componentNames: false });
  const button = document.querySelector('button')!;
  button.addEventListener('click', () => { document.body.innerHTML = `<aside data-reader-mode="sheet"><input data-search-input value="SECRET input https://secret.invalid/path"><li data-report-key="SECRET"><article><div><button aria-expanded="false"><span>SECRET body</span></button></div></article></li><button data-strips aria-pressed="false">SECRET</button></aside>`; });
  button.click();
  document.querySelector('input')!.dispatchEvent(new Event('input', { bubbles: true }));
  document.querySelector<HTMLButtonElement>('article button')!.click();
  document.querySelector<HTMLButtonElement>('[data-strips]')!.click();
  document.querySelector('[data-strips]')!.setAttribute('aria-pressed', 'true');
  for (let n = 0; n < 30; n++) document.dispatchEvent(new Event('scroll'));
  await vi.advanceTimersByTimeAsync(5000);
  const sample = JSON.parse(fetch.mock.calls[0]![1].body);
  expect(readSample(sample)).toBeDefined();
  expect(sample.context.atStart).toEqual(['list']);
  expect(sample.context.atSample).toEqual(['detail', 'timeline']);
  expect(sample.context.events.slice(0, 4).map((e: any) => e.kind)).toEqual(['intent-task-open', 'search-input', 'intent-body-open', 'intent-timeline-open']);
  expect(sample.context.events[0].screen).toEqual(['list']);
  expect(sample.context.events[1].screen).toEqual(['detail']);
  expect(sample.context.events).toHaveLength(MAX_CONTEXT_EVENTS); expect(sample.context.dropped).toBe(10);
  expect(JSON.stringify(sample)).not.toMatch(/SECRET|secret.invalid|TSECRET/);
  document.dispatchEvent(new Event('scroll'));
  state.mockReturnValue('hidden'); document.dispatchEvent(new Event('visibilitychange'));
  document.dispatchEvent(new Event('scroll'));
  state.mockReturnValue('visible'); document.dispatchEvent(new Event('visibilitychange'));
  await vi.advanceTimersByTimeAsync(5000);
  expect(JSON.parse(fetch.mock.calls[1]![1].body).context.events).toEqual([]);
  window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
  window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  document.dispatchEvent(new Event('scroll'));
  await vi.advanceTimersByTimeAsync(5000);
  expect(JSON.parse(fetch.mock.calls[2]![1].body).context.events.map((e: any) => e.kind)).toEqual(['scroll']);
  dispose();
  document.dispatchEvent(new Event('scroll'));
  document.querySelector('input')!.dispatchEvent(new Event('input', { bubbles: true }));
  await vi.advanceTimersByTimeAsync(5000); expect(fetch).toHaveBeenCalledTimes(3);
});

test('numeric phase/resource details are capped, private URLs discarded, and late main input survives scroll cap', async () => {
  vi.useFakeTimers(); vi.resetModules();
  const state = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  const receive = new Map<string, (list: { getEntries(): object[] }) => void>();
  const options: object[] = [];
  vi.stubGlobal('PerformanceObserver', class {
    static supportedEntryTypes = ['event', 'resource', 'long-animation-frame'];
    constructor(private callback: (list: { getEntries(): object[] }) => void) {}
    observe(option: { type: string }) { receive.set(option.type, this.callback); options.push(option); }
    disconnect() {}
  });
  vi.stubGlobal('PerformanceLongAnimationFrameTiming', class { get renderStart() { return 0; } get styleAndLayoutStart() { return 0; } });
  const fetch = vi.fn().mockResolvedValue({ ok: true }); vi.stubGlobal('fetch', fetch);
  const { startPerformance } = await import('../dev/performance-client');
  const { readSample, MAX_DETAIL_ENTRIES } = await import('../../backend/src/diagnostics/protocol');
  const dispose = startPerformance({ buildId: 'a'.repeat(40) + '-diagnostic', componentNames: false });
  expect(options).toContainEqual({ type: 'event', buffered: true, durationThreshold: 16 });
  receive.get('event')!({ getEntries: () => Array.from({ length: MAX_DETAIL_ENTRIES + 1 }, () => ({ startTime: 10, duration: 96, processingStart: 30, processingEnd: 70, name: 'PRIVATE', target: document.body })) });
  receive.get('long-animation-frame')!({ getEntries: () => [{ startTime: 10, duration: 100, blockingDuration: 20, renderStart: 60, styleAndLayoutStart: 80, scripts: [{ sourceURL: 'PRIVATE' }] }] });
  receive.get('resource')!({ getEntries: () => ['/api/task/PRIVATE?secret=PRIVATE', '/assets/PRIVATE.js', '/api/events', '/PRIVATE'].map(path => ({ name: new URL(path, location.href).href, duration: 50, transferSize: 100, requestStart: 10, responseStart: 25, initiatorType: 'fetch' })) });
  for (let n = 0; n < 30; n++) document.dispatchEvent(new Event('scroll'));
  document.body.innerHTML = '<button data-list-next="PRIVATE">PRIVATE</button><li data-row="PRIVATE"></li><li data-report-key="PRIVATE"></li><button data-report-key="PRIVATE">image</button>';
  document.querySelector('button')!.click();
  await vi.advanceTimersByTimeAsync(5000);
  const sample = JSON.parse(fetch.mock.calls[0]![1].body);
  expect(readSample(sample)).toBeDefined();
  expect(sample.details.input).toEqual({ count: 500, dropped: 1, inputDelayMs: 10000, maxInputDelayMs: 20, processingMs: 20000, presentationMs: 18000, durationMs: 48000, maxDurationMs: 96 });
  expect(sample.details.render).toEqual({ count: 1, dropped: 0, preRenderMs: 50, renderMs: 50, styleLayoutMs: 30 });
  for (const row of Object.values(sample.details.resources) as any[]) expect(row).toEqual({ count: 1, durationMs: 50, maxDurationMs: 50, ttfbCount: 1, ttfbMs: 15, transferBytes: 100, dropped: 0 });
  expect(sample.details.dom).toMatchObject({ rows: 1, reports: 1 });
  expect(sample.context.events.at(-1).kind).toBe('intent-task-next'); expect(sample.context.dropped).toBe(7);
  expect(JSON.stringify(sample)).not.toContain('PRIVATE');
  state.mockReturnValue('hidden'); document.dispatchEvent(new Event('visibilitychange'));
  receive.get('event')!({ getEntries: () => [{ startTime: 10, duration: 96, processingStart: 30, processingEnd: 70 }] });
  state.mockReturnValue('visible'); document.dispatchEvent(new Event('visibilitychange'));
  await vi.advanceTimersByTimeAsync(5000);
  const reset = JSON.parse(fetch.mock.calls[1]![1].body);
  expect(reset.details.input.count).toBe(0); expect(reset.details.render.count).toBe(0);
  expect(reset.details.resources.api.count).toBe(0); expect(reset.context.events).toEqual([]);
  dispose();
});

test('page lifecycle survives hidden resets and BFCache, combines notifications without a resume count', async () => {
  vi.useFakeTimers(); vi.resetModules();
  const state = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  const fetch = vi.fn().mockResolvedValue({ ok: true }); vi.stubGlobal('fetch', fetch);
  const { startPerformance } = await import('../dev/performance-client');
  const { readSample } = await import('../../backend/src/diagnostics/protocol');
  const dispose = startPerformance({ buildId: 'development', componentNames: true });
  await vi.advanceTimersByTimeAsync(5000);
  const first = JSON.parse(fetch.mock.calls[0]![1].body);
  expect(first.lifecycle).toMatchObject({ initialVisibility: 'visible', hiddenObserved: false, pagehideObserved: false,
    triggersSinceSample: [], sinceReturnTriggerPerfMs: null, sampleGapWallMs: null, sampleGapPerfMs: null });
  await vi.advanceTimersByTimeAsync(1000);
  state.mockReturnValue('hidden'); document.dispatchEvent(new Event('visibilitychange'));
  document.dispatchEvent(new Event('resume'));
  await vi.advanceTimersByTimeAsync(1000);
  state.mockReturnValue('visible'); document.dispatchEvent(new Event('visibilitychange'));
  window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
  window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  document.dispatchEvent(new Event('resume')); document.dispatchEvent(new Event('resume'));
  await vi.advanceTimersByTimeAsync(5000);
  const restored = JSON.parse(fetch.mock.calls[1]![1].body);
  expect(readSample(restored)).toBeDefined(); expect(restored.tab).not.toBe(first.tab);
  expect(restored.lifecycle).toMatchObject({ initialVisibility: 'visible', hiddenObserved: true, pagehideObserved: true,
    hiddenWallMs: 1000, sinceHiddenEndPerfMs: 5000, sinceReturnTriggerPerfMs: 5000, sampleGapWallMs: 7000, sampleGapPerfMs: 7000 });
  expect([...restored.lifecycle.triggersSinceSample].sort()).toEqual(['pageshow-persisted', 'resume', 'visibility-visible']);
  expect(restored.lifecycle).not.toHaveProperty('resumeCount');
  await vi.advanceTimersByTimeAsync(5000);
  expect(JSON.parse(fetch.mock.calls[2]![1].body).lifecycle).toMatchObject({ triggersSinceSample: [], sinceReturnTriggerPerfMs: 10000, sampleGapPerfMs: 5000 });
  dispose();
});

test('initial hidden/unknown and wall clock rollback remain explicit', async () => {
  const { createLifecycle } = await import('../dev/performance-lifecycle');
  const life = createLifecycle('hidden', 100);
  expect(life.sample(1, 100)).toMatchObject({ initialVisibility: 'hidden', hiddenObserved: true, hiddenWallMs: null });
  life.visibility('visible', 10, 80);
  life.sent(10, 100);
  expect(life.sample(20, 90)).toMatchObject({ hiddenWallMs: null, sinceHiddenEndPerfMs: null, sampleGapWallMs: null, sampleGapPerfMs: 10, sinceReturnTriggerPerfMs: 10 });
  expect(createLifecycle('prerender', 100).sample(1, 100).initialVisibility).toBe('unknown');
});
