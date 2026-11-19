/** An instrument derived from motion-probe.ts, with CSS transition and separate trace observation. Installed before the page loads; each `run` measures one press over a fixed window: rAF frame gaps,
 * Long Animation Frames, CDP layout/style/script time, React commits, and the properties each Element.animate drew.
 * Optional: `film` keeps every frame the compositor drew (<output>.film/<width>-<name>/<ms>.jpg), `profile` the hottest
 * functions (raw with PERF_RAW_PROFILE). Each costs CPU: time them in a run of their own.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import type { BrowserContext, CDPSession, Page } from '@playwright/test';

type Probe = { frames: number[]; last: number; loaf: { duration: number; blocking: number; styleLayout: number; render: number; scripts: string[] }[]; commits: number;
  css: { target: string; props: string[] }[]; animations: { target: string; props: string[]; duration: unknown }[] };
declare global { interface Window { listMotion: Probe } }
export type MotionRun = { width: number; name: string; valid: boolean; frames: { missed: number; late: number; max?: number };
  animations: Probe['animations']; [key: string]: unknown };

export async function installProbe(page: Page) {
  await page.addInitScript(() => {
    const probe: Probe = window.listMotion = { frames: [], last: 0, loaf: [], commits: 0, css: [], animations: [] };

    const frame = (at: number) => { if (probe.last) probe.frames.push(at - probe.last); probe.last = at;
      requestAnimationFrame(frame); };
    requestAnimationFrame(frame);
    document.addEventListener('transitionrun',event=> { const each=event as TransitionEvent; probe.css.push({target:(each.target as Element).className?.toString()??'',props:[each.propertyName]}); });
    try { new PerformanceObserver(list => { for (const entry of list.getEntries() as any[]) probe.loaf.push({ duration: entry.duration, blocking: entry.blockingDuration,
      // How much of the frame was its style and layout, and its rendering as a whole (after its scripts).
      styleLayout: entry.styleAndLayoutStart ? entry.startTime + entry.duration - entry.styleAndLayoutStart : 0,
      render: entry.renderStart ? entry.startTime + entry.duration - entry.renderStart : 0,
      scripts: entry.scripts.map((each: any) => `${Math.round(each.duration)}ms ${each.invokerType} ${each.invoker} ${each.sourceFunctionName}`) }); })
      .observe({ type: 'long-animation-frame', buffered: false }); } catch { /* unsupported */ }
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (frames, options) {
      const list = Array.isArray(frames) ? frames : frames ? [frames] : [];
      const props = [...new Set(list.flatMap(each => Object.keys(each ?? {}).filter(key => !['offset', 'easing', 'composite'].includes(key))))];
      const name = this.getAttributeNames().filter(each => each.startsWith('data-')).slice(0, 3).join(',') || this.tagName.toLowerCase();
      probe.animations.push({ target: name, props, duration: typeof options === 'number' ? options : options?.duration });
      return animate.call(this, frames, options);
    };
    Object.defineProperty(window, '__REACT_DEVTOOLS_GLOBAL_HOOK__', { value: {
      renderers: new Map(), supportsFiber: true, isDisabled: false, checkDCE() {},
      inject() { return 1; }, onCommitFiberRoot() { probe.commits++; },
      onCommitFiberUnmount() {}, onPostCommitFiberRoot() {}, onScheduleFiberRoot() {},
    } });
  });
}

/** Measures presses on `page` (its probe installed): each `run` is appended to `results` and written to `output`. */
export async function measurer(page: Page, context: BrowserContext, { output, width, throttle, film = false, profile = false, trace = false, extra = {} }:
  { output: string; width: number; throttle: number; film?: boolean; profile?: boolean; trace?: boolean; extra?: Record<string, unknown> }, results: unknown[]) {
  const cdp: CDPSession = await context.newCDPSession(page);
  await cdp.send('Performance.enable'); await cdp.send('Page.enable');
  const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(item => [item.name, item.value]));
  const browserVersion = context.browser()?.version();
  return async (name: string, span: number, work: () => Promise<unknown>, isValid: (animations: Probe['animations']) => boolean = () => true) => {
    await page.waitForTimeout(500);
    if (throttle > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
    const events:any[]=[];
    const collect=(event:{value:any[]})=>events.push(...event.value);
    if(trace){cdp.on('Tracing.dataCollected',collect);await cdp.send('Tracing.start',{categories:'devtools.timeline,blink.animations,disabled-by-default-devtools.timeline.invalidationTracking',transferMode:'ReportEvents'});}
    const hostBefore = { at: new Date().toISOString(), load: loadavg() };
    const before = await metrics();
    await page.evaluate(() => Object.assign(window.listMotion, { frames: [], last: 0, loaf: [], commits: 0, css: [], animations: [] }));
    const shots: { at: number; data: string }[] = [];
    const frame = (shot: { data: string; sessionId: number; metadata: { timestamp?: number } }) => {
      shots.push({ at: shot.metadata.timestamp ?? 0, data: shot.data });
      void cdp.send('Page.screencastFrameAck', { sessionId: shot.sessionId }).catch(() => {});
    };
    if (film) { cdp.on('Page.screencastFrame', frame); await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 80, everyNthFrame: 1 }); await page.waitForTimeout(150); shots.length = 0; }
    const began = Date.now() / 1000;
    if (profile) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 100 }); await cdp.send('Profiler.start'); }
    await work();
    await page.waitForTimeout(span);
    const after = await metrics();
    if(trace){const ended=new Promise<void>(done=>cdp.once('Tracing.tracingComplete',()=>done()));await cdp.send('Tracing.end');await ended;cdp.off('Tracing.dataCollected',collect);
      writeFileSync(output+'.'+width+'-'+name+'.trace.json',JSON.stringify({traceEvents:events}));}
    const traceMs=(name:string)=>events.filter(e=>e.ph==='X'&&e.name===name).reduce((sum,e)=>sum+(e.dur||0)/1000,0);
    if (film) {
      await cdp.send('Page.stopScreencast'); cdp.off('Page.screencastFrame', frame);
      const dir = `${output}.film/${width}-${name}`;
      mkdirSync(dir, { recursive: true });
      for (const shot of shots) writeFileSync(`${dir}/${String(Math.max(0, Math.round((shot.at - began) * 1000))).padStart(5, '0')}.jpg`, Buffer.from(shot.data, 'base64'));
    }
    let hot: { fn: string; selfMs: number; totalMs: number }[] = [];
    if (profile) {
      const { profile: sampled } = await cdp.send('Profiler.stop');
      if (process.env.PERF_RAW_PROFILE) writeFileSync(`${output}.${width}-${name}.cpuprofile`, JSON.stringify(sampled));
      // Self time per sampled node, and its total: the node's own time with all under it, summed by name.
      const self = new Map<number, number>();
      sampled.samples!.forEach((id, i) => self.set(id, (self.get(id) ?? 0) + (sampled.timeDeltas![i] ?? 0) / 1000));
      const byId = new Map(sampled.nodes.map(node => [node.id, node]));
      const total = new Map<number, number>();
      const sum = (id: number): number => { const node = byId.get(id)!; const value = (self.get(id) ?? 0) + (node.children ?? []).reduce((a, child) => a + sum(child), 0); total.set(id, value); return value; };
      sum(sampled.nodes[0]!.id);
      const label = (id: number) => { const f = byId.get(id)!.callFrame; return `${f.functionName || '(anon)'} ${f.url.split('/').pop()}:${f.lineNumber + 1}`; };
      const agg = new Map<string, { selfMs: number; totalMs: number }>();
      for (const node of sampled.nodes) {
        const key = label(node.id), was = agg.get(key) ?? { selfMs: 0, totalMs: 0 };
        // Recursion would count a total twice: keep the largest single total for a name.
        agg.set(key, { selfMs: was.selfMs + (self.get(node.id) ?? 0), totalMs: Math.max(was.totalMs, total.get(node.id) ?? 0) });
      }
      hot = [...agg].map(([fn, v]) => ({ fn, ...v })).filter(v => !/^\((idle|program|root)\)/.test(v.fn)).sort((a, b) => b.totalMs - a.totalMs).slice(0, 40);
      await cdp.send('Profiler.disable');
    }
    const probe = await page.evaluate(() => window.listMotion);
    if (throttle > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    const gaps = [...probe.frames].sort((a, b) => a - b);
    // A gap over 1.5 frames at 60Hz is a frame not drawn on time; how many it missed is how many 16.7ms it spans past one.
    const missed = probe.frames.reduce((sum, gap) => sum + Math.max(0, Math.round(gap / 16.67) - 1), 0);
    const delta = (key: string) => (after[key] ?? 0) - (before[key] ?? 0);
    const valid = isValid(probe.animations);
    const result = { width, name, throttle, ...extra, valid, host: { before: hostBefore, after: { at: new Date().toISOString(), load: loadavg() } },
      frames: { count: gaps.length, p50: gaps[Math.floor(gaps.length * .5)], p95: gaps[Math.floor(gaps.length * .95)], max: gaps.at(-1), late: gaps.filter(gap => gap > 25).length, missed },
      loaf: { count: probe.loaf.length, totalMs: probe.loaf.reduce((sum, each) => sum + each.duration, 0), blockingMs: probe.loaf.reduce((sum, each) => sum + each.blocking, 0), frames: probe.loaf },
      commits: probe.commits,
      cdp: { taskMs: delta('TaskDuration') * 1000, scriptMs: delta('ScriptDuration') * 1000, layoutMs: delta('LayoutDuration') * 1000,
        styleMs: delta('RecalcStyleDuration') * 1000, layouts: delta('LayoutCount'), styles: delta('RecalcStyleCount') },
      trace: trace ? {layoutMs:traceMs('Layout'),styleMs:traceMs('UpdateLayoutTree'),paintMs:traceMs('Paint'),paintCount:events.filter(e=>e.ph==='X'&&e.name==='Paint').length} : undefined, css: probe.css, animations: probe.animations, hot };
    results.push(result);
    writeFileSync(output, JSON.stringify({ version: 1, browser: browserVersion, throttle, results }, null, 2));
    console.log(`${width} ${name}${valid ? '' : ' (invalid)'}: missed=${missed} late=${result.frames.late} max=${Math.round(result.frames.max ?? 0)} layouts=${result.cdp.layouts} layoutMs=${Math.round(result.cdp.layoutMs)} task=${Math.round(result.cdp.taskMs)} commits=${probe.commits} anim=${probe.animations.map(a => a.target + ':' + a.props.join('+')).join(' ')}`);
    return result as unknown as MotionRun;
  };
}
