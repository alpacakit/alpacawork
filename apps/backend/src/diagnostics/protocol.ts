/** Local diagnostics contain measurements, never application data or resource URLs. */
export const ENDPOINT = '/__dev-performance';
export const INTERVAL_MS = 5_000;
// A cold formal CLI can block its event loop ~12.4s before accepting HTTP. Keep
// one in-flight send, but allow that measured startup wait plus a finite margin.
export const SEND_DEADLINE_MS = 20_000;
export const MAX_LOG_BYTES = 1024 * 1024;
export const MAX_REQUEST_BYTES = 16 * 1024;
const METRICS = [
  'visibleMs', 'frames', 'frameMs', 'fps', 'framesOverBudget', 'maxFrameMs', 'scrolls', 'scrollFramesOverBudget',
  'reactCommits', 'componentRenders', 'reactRenderMs', 'longTasks', 'longTaskMs', 'maxLongTaskMs',
  'longFrames', 'longFrameMs', 'blockingMs', 'resources', 'resourceMs', 'maxResourceMs', 'transferBytes',
  'domElements', 'heapBytes',
] as const;
const SUPPORTED = ['reactCommits', 'reactRender', 'componentNames', 'longtask', 'longFrame', 'resource', 'heap', 'eventTiming', 'renderPhases'] as const;
export const MAX_DETAIL_ENTRIES = 500;
export const INPUT_KEYS = ['count', 'inputDelayMs', 'maxInputDelayMs', 'processingMs', 'presentationMs', 'durationMs', 'maxDurationMs', 'dropped'] as const;
export const RENDER_KEYS = ['count', 'preRenderMs', 'renderMs', 'styleLayoutMs', 'dropped'] as const;
export const RESOURCE_KEYS = ['count', 'durationMs', 'maxDurationMs', 'ttfbCount', 'ttfbMs', 'transferBytes', 'dropped'] as const;
export const RESOURCE_CATEGORIES = ['api', 'asset', 'stream', 'other'] as const;
export const DOM_KEYS = ['rows', 'reports', 'viewportWidth', 'viewportHeight'] as const;
export const RETURN_TRIGGERS = ['visibility-visible', 'resume', 'pageshow-persisted'] as const;
export const VISIBILITIES = ['visible', 'hidden', 'unknown'] as const;
export const LIFECYCLE_TIMES = ['hiddenWallMs', 'sinceHiddenEndPerfMs', 'sinceReturnTriggerPerfMs', 'sampleGapWallMs', 'sampleGapPerfMs'] as const;
export type ReturnTrigger = typeof RETURN_TRIGGERS[number];
export type Lifecycle = { initialVisibility: typeof VISIBILITIES[number]; hiddenObserved: boolean; pagehideObserved: boolean;
  triggersSinceSample: ReturnTrigger[] } & Record<typeof LIFECYCLE_TIMES[number], number | null>;
export const emptyLifecycle = (): Lifecycle => ({ initialVisibility: 'unknown', hiddenObserved: false, pagehideObserved: false, triggersSinceSample: [],
  hiddenWallMs: null, sinceHiddenEndPerfMs: null, sinceReturnTriggerPerfMs: null, sampleGapWallMs: null, sampleGapPerfMs: null });
type Numbers<K extends readonly string[]> = Record<K[number], number>;
export type Details = { input: Numbers<typeof INPUT_KEYS> | null; render: Numbers<typeof RENDER_KEYS> | null;
  resources: Record<typeof RESOURCE_CATEGORIES[number], Numbers<typeof RESOURCE_KEYS>> | null; dom: Numbers<typeof DOM_KEYS> };
export const zeroes = <K extends readonly string[]>(keys: K): Numbers<K> => Object.fromEntries(keys.map(key => [key, 0])) as Numbers<K>;
export const emptyDetails = (): Details => ({ input: null, render: null, resources: null, dom: zeroes(DOM_KEYS) });
export const MAX_CONTEXT_EVENTS = 24;
export const SCREENS = ['unknown', 'list', 'detail', 'conversation', 'timeline'] as const;
export const ACTIONS = ['intent-task-open', 'intent-task-next', 'intent-task-previous', 'intent-reader-back',
  'intent-body-open', 'intent-body-close', 'intent-timeline-open', 'intent-timeline-close', 'search-input', 'scroll'] as const;
export type Screen = typeof SCREENS[number];
export type Action = typeof ACTIONS[number];
export type Context = { atStart: Screen[]; atSample: Screen[]; events: { atMs: number; kind: Action; screen: Screen[] }[]; dropped: number };
type Metrics = Record<Exclude<typeof METRICS[number], 'reactRenderMs' | 'componentRenders'>, number> & { reactRenderMs: number | null; componentRenders: number | null };
export const emptyMetrics = (): Metrics => Object.fromEntries(METRICS.map(key => [key, 0])) as Metrics;
export type Sample = { buildId: string; tab: string; sinceMs: number; metrics: Metrics; components: { name: string; renders: number }[]; context: Context; details: Details; lifecycle: Lifecycle;
  supported: Record<typeof SUPPORTED[number], boolean> };
const number = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1e12;
const screens = (value: unknown): value is Screen[] => Array.isArray(value) && value.length > 0 && value.length <= SCREENS.length
  && value.every(item => SCREENS.includes(item)) && new Set(value).size === value.length
  && (!value.includes('unknown') || value.length === 1);
function readNumbers<K extends readonly string[]>(value: unknown, keys: K): Numbers<K> | undefined {
  if (!value || typeof value !== 'object') return;
  const row = value as Record<string, unknown>;
  if (!keys.every(key => number(row[key]))) return;
  for (const key of ['count', 'ttfbCount', 'dropped']) if (key in row && (!number(row[key]) || !Number.isInteger(row[key]))) return;
  if ('count' in row && (row.count as number) > MAX_DETAIL_ENTRIES) return;
  if ('ttfbCount' in row && (row.ttfbCount as number) > (row.count as number)) return;
  return Object.fromEntries(keys.map(key => [key, row[key]])) as Numbers<K>;
}
/** Fixed allowlist at the receiving boundary; unknown fields are not written to disk. */
export function readSample(value: unknown): Sample | undefined {
  if (!value || typeof value !== 'object') return;
  const input = value as Sample;
  if (typeof input.buildId !== 'string' || !/^(?:development|[0-9a-f]{40}-diagnostic)$/.test(input.buildId) || typeof input.tab !== 'string' || !/^[a-z0-9-]{1,40}$/.test(input.tab) || !number(input.sinceMs)
    || !input.metrics || !METRICS.every(key => number(input.metrics[key]) || (['reactRenderMs', 'componentRenders'].includes(key) && input.metrics[key] === null))
    || !input.supported || !SUPPORTED.every(key => typeof input.supported[key] === 'boolean')
    || !Array.isArray(input.components) || input.components.length > 10
    || !input.components.every(row => row && typeof row.name === 'string' && /^[A-Za-z_$][\w.$-]{0,63}$/.test(row.name) && number(row.renders))) return;
  if (input.buildId !== 'development' && input.supported.componentNames) return;
  if ((!input.supported.reactRender && input.metrics.reactRenderMs !== null) || (!input.supported.componentNames && (input.metrics.componentRenders !== null || input.components.length))) return;
  const context = input.context;
  if (!context || !screens(context.atStart) || !screens(context.atSample) || !number(context.dropped) || !Number.isInteger(context.dropped)
    || !Array.isArray(context.events) || context.events.length > MAX_CONTEXT_EVENTS
    || !context.events.every((event, i) => event && number(event.atMs) && event.atMs <= input.metrics.visibleMs
      && (i === 0 || event.atMs >= context.events[i - 1]!.atMs) && ACTIONS.includes(event.kind) && screens(event.screen))) return;
  const detail = input.details;
  if (!detail) return;
  const dom = readNumbers(detail.dom, DOM_KEYS);
  const inputTiming = input.supported.eventTiming ? readNumbers(detail.input, INPUT_KEYS) : detail.input === null ? null : undefined;
  const render = input.supported.renderPhases ? readNumbers(detail.render, RENDER_KEYS) : detail.render === null ? null : undefined;
  if (input.supported.renderPhases && !input.supported.longFrame) return;
  let resources: Details['resources'] = null;
  if (input.supported.resource) {
    if (!detail.resources || typeof detail.resources !== 'object') return;
    resources = {} as NonNullable<Details['resources']>;
    for (const category of RESOURCE_CATEGORIES) {
      const row = readNumbers(detail.resources[category], RESOURCE_KEYS);
      if (!row) return;
      resources[category] = row;
    }
  } else if (detail.resources !== null) return;
  if (!dom || inputTiming === undefined || render === undefined || !DOM_KEYS.every(key => Number.isInteger(dom[key]))) return;
  const life = input.lifecycle;
  if (!life || !VISIBILITIES.includes(life.initialVisibility) || typeof life.hiddenObserved !== 'boolean' || typeof life.pagehideObserved !== 'boolean'
    || !LIFECYCLE_TIMES.every(key => life[key] === null || number(life[key])) || !Array.isArray(life.triggersSinceSample)
    || life.triggersSinceSample.length > RETURN_TRIGGERS.length || !life.triggersSinceSample.every(key => RETURN_TRIGGERS.includes(key))
    || new Set(life.triggersSinceSample).size !== life.triggersSinceSample.length
    || (life.initialVisibility === 'hidden' && !life.hiddenObserved)
    || (life.triggersSinceSample.length > 0 && life.sinceReturnTriggerPerfMs === null)
    || (life.hiddenWallMs !== null && (!life.hiddenObserved || life.sinceHiddenEndPerfMs === null))
    || (life.hiddenWallMs === null && life.sinceHiddenEndPerfMs !== null)) return;
  return { buildId: input.buildId, tab: input.tab, sinceMs: input.sinceMs, metrics: Object.fromEntries(METRICS.map(key => [key, input.metrics[key]])) as Metrics,
    lifecycle: { initialVisibility: life.initialVisibility, hiddenObserved: life.hiddenObserved, pagehideObserved: life.pagehideObserved,
      triggersSinceSample: [...life.triggersSinceSample], ...Object.fromEntries(LIFECYCLE_TIMES.map(key => [key, life[key]])) } as Lifecycle,
    details: { input: inputTiming, render, resources, dom },
    context: { atStart: [...context.atStart], atSample: [...context.atSample], dropped: context.dropped,
      events: context.events.map(({ atMs, kind, screen }) => ({ atMs, kind, screen: [...screen] })) },
    components: input.components.map(({ name, renders }) => ({ name, renders })),
    supported: Object.fromEntries(SUPPORTED.map(key => [key, input.supported[key]])) as Sample['supported'] };
}
