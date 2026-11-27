/** Phone operation survey; derived from interaction-latency.ts. Timing and --profile/--video runs must stay separate. */
/** Native press to finished motion on the common perf fixture. Timing runs and --profile runs stay separate. */
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, writeFileSync, appendFileSync, cpSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadavg, cpus, freemem, totalmem } from 'node:os';
import { chromium, type Browser, type Locator } from '@playwright/test';
import { copyWorkspace, createOriginal, profiles, removeWorkspace } from '../../scripts/dev-fixtures/fixture.ts';

import { patchTask, seedQuestion } from '../fixture/task-state.ts';
import { ControlStore } from '@alpacawork/db';
import { startFakeCoordinator } from '../coordinator-fixture.ts';
import { decideValues } from '../../tests/helpers/task-values.ts';
import { leaveBarMenu, settingsEntry, STRIPS_SHOWN, stripsSwitch } from './bar-entries.ts';

/** The conversation's ⌄ (a phone has one too), else Esc. */
async function foldChat(page: any, press: (target: any) => Promise<unknown> = target => target.click()) {
  const fold = page.locator('[data-coordinator-panel] [data-coordinator-fold]').first();
  if (await fold.count()) await press(fold); else await page.keyboard.press('Escape');
}

const { values: args } = parseArgs({ options: {
  'search-only':{type:'boolean'}, 'messages-only':{type:'boolean'}, 'list-scene':{type:'boolean'}, catalog: { type: 'boolean' }, inventory: { type: 'boolean' }, questions: { type: 'boolean' }, video: { type: 'boolean' }, release: { type: 'string' }, out: { type: 'string' }, rounds: { type: 'string', default: '6' },
  'count-patches':{type:'string'}, throttle: { type: 'string', default: '4' }, height: { type: 'string', default: '900' },
  detail: { type: 'boolean', default: false }, 'expanded-list': { type: 'boolean', default: false }, 'profile-only':{type:'string'}, profile: { type: 'boolean', default: false }, paragraphs: { type: 'string', default: '40' },
} });
if (!args.release || !args.out) throw new Error('--release and --out are required');
const release = resolve(args.release), out = resolve(args.out);
mkdirSync(out, { recursive: true });
const original = createOriginal({ ...(args.questions ? profiles.small : profiles.perf), seed: 'synthetic-v1' });
const root = join(out, 'workspace');
copyWorkspace(original.root, root);
const questionIds = ['T3','T7','T8','T9'];
const questionRefs: Record<string, string> = {};
try { if (args.questions || args['list-scene']) {
  if(args.questions) startFakeCoordinator(root);
  for (const id of args['list-scene'] ? Array.from({length:17},(_,n)=>'T'+(n+2)) : questionIds) {
    patchTask(root, id, { state: 'doing', userRequested: true, values: decideValues(['色を選んでください', ['A 青', '青にする'], ['B 赤', '赤にする']]) });
    questionRefs[id] = seedQuestion(root, id, { to: 'user' });
  }
}
} catch(error) { cpSync(root,join(out,'failure-setup-workspace'),{recursive:true});removeWorkspace(root);throw error; }
writeFileSync(join(out, 'fixture.json'), JSON.stringify({ original, questionRefs, modifications: args['list-scene'] ? '17 existing T2..T18 bodies/states/user marks/open asked logs; original counts retained except +17 asked logs' : args.questions ? '4 bodies/states/user marks/open asked logs; fake coordinator config' : 'GET coordinator conversation route (40 turns/40 paragraphs) only' }, null, 2));
const processes = () => execFileSync('/bin/ps', ['-eo','pid,ppid,pcpu,stat,args'], {encoding:'utf8'});
writeFileSync(join(out,'host-before.txt'), JSON.stringify({at:new Date().toISOString(),load:loadavg(),cpus:cpus().length,free:freemem(),total:totalmem()})+'\n'+processes());
const child = spawn(process.execPath, [join(release, 'apps/backend/dist/backend.js'), '--workspace', root, 'workspace', 'serve', '--port', '0'], {
  env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('ALPACAWORK_'))), stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
child.stdout.on('data', bytes => { log += bytes; appendFileSync(join(out,'server.log'),bytes); }); child.stderr.on('data', bytes => { log += bytes; appendFileSync(join(out,'server.log'),bytes); });
writeFileSync(join(out,'processes.json'),JSON.stringify({runner:process.pid,server:child.pid,deadline:new Date(Date.now()+25*60_000).toISOString()}));
let browser: Browser | undefined;
const expiry = setTimeout(() => { child.kill('SIGTERM'); void browser?.close(); process.exitCode = 3; }, 25 * 60_000);
const results: unknown[] = [];
const save = () => {
  writeFileSync(join(out, 'server.log'), log);
  writeFileSync(join(out, 'results.json'), JSON.stringify({ release, source: args.questions ? 'common synthetic small + question/fake-coordinator' : 'common synthetic perf', fixture: { key: original.key, counts: original.counts },
    runnerPid: process.pid, serverPid: child.pid, listScene:args['list-scene'], questions:args.questions, catalog:args.catalog, capturedAt: new Date().toISOString(), browser: browser?.version(), width: 390, height: Number(args.height), throttle: Number(args.throttle), expandedList: args['expanded-list'], profile: args.profile, paragraphs: Number(args.paragraphs), results }, null, 2));
};
// A paired runner gates each complete operation, so the other page does no preparation during its measurement.
const gate = async (phase: 'ready' | 'done', name: string) => {
  if (!process.send) return;
  await new Promise<void>((resolve, reject) => {
    const disconnected = () => { process.off('message', message); reject(new Error('Paired runner disconnected')); };
    const message = (value: unknown) => {
      process.off('disconnect', disconnected);
      value === (phase === 'ready' ? 'go' : 'advance') ? resolve() : reject(new Error('Unexpected paired instruction'));
    };
    process.once('message', message); process.once('disconnect', disconnected);
    process.send!({ phase, name });
  });
};
const disconnected = () => { child.kill('SIGTERM'); void browser?.close(); process.exitCode = 3; };
process.once('disconnect', disconnected);
process.once('SIGTERM', disconnected);
process.once('SIGINT', disconnected);
try {
  browser = await chromium.launch();
  let url = '';
  const deadline = Date.now() + 60_000;
  while (!(url = /http:\/\/[\w.:]+/.exec(log)?.[0] ?? '')) {
    if (child.exitCode !== null || Date.now() > deadline) throw new Error(`Serve not ready: ${log}`);
    await new Promise(done => setTimeout(done, 50));
  }
  // Initial server reconciliation is outside the operation windows.
  let calm = Date.now();
  const calmDeadline = calm + 60_000;
  while (Date.now() - calm < 5000) {
    const asked = Date.now();
    await fetch(url + '/api/task/view?task=T2').then(reply => reply.text());
    if (Date.now() - asked > 300) calm = Date.now();
    if (Date.now() > calmDeadline) throw new Error('Server did not settle');
    await new Promise(done => setTimeout(done, 100));
  }
  writeFileSync(join(out,'process-tree-start.txt'),processes());
  if (args.catalog) {
    const reply=await fetch(url+'/api/commands/task/new',{method:'POST',headers:{'content-type':'application/json','x-alpacawork-op-id':crypto.randomUUID()},body:JSON.stringify({kind:'project',color:'#795548',parent:'none',title:'Synthetic secondary project'})});
    const result=await reply.json();if(!reply.ok)throw Error(JSON.stringify(result));writeFileSync(join(out,'secondary-project.json'),JSON.stringify(result,null,2));
  }
  const countsStore=new ControlStore(root,{busyTimeoutMs:1000},true);
  try {writeFileSync(join(out,'fixture-runtime-counts.json'),JSON.stringify(countsStore.read(db=>Object.fromEntries(['tasks','task_log','runs','requests','placements'].map(table=>[table,db.prepare('SELECT count(*) n FROM '+table).get()!.n]))),null,2));}finally{countsStore.close();}
  const context = await browser.newContext({ ...(args.video ? {recordVideo:{dir:join(out,'video'),size:{width:390,height:900}}}:{}), viewport: { width: 390, height: Number(args.height) }, hasTouch: true, isMobile: true,
    locale: 'en-US', timezoneId: 'Asia/Tokyo', serviceWorkers: 'block' });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  const errors: string[] = [];
  page.on('pageerror', error => {errors.push(error.message);appendFileSync(join(out,'browser-errors.log'),String(error.stack)+'\n');});
  if(args['count-patches']) {
    const patches: {asset:string;prefix:string;label:string}[]=JSON.parse(readFileSync(args['count-patches'],'utf8'));
    await page.addInitScript(()=>{const w=window as any;w.__counts={};w.__count=(name:string)=>{if(w.interaction?.armed&&w.interaction.start&&!w.interaction.done)w.__counts[name]=(w.__counts[name]??0)+1;};});
    await page.route('**/assets/*.js',async route=>{
      const selected=patches.filter(p=>route.request().url().endsWith('/'+p.asset));
      if(!selected.length){await route.continue();return;}
      const response=await route.fetch();let body=await response.text();
      for(const p of selected){if(body.split(p.prefix).length!==2)throw Error('Ambiguous count probe '+p.label);body=body.replace(p.prefix,p.prefix+`window.__count?.(${JSON.stringify(p.label)});`);}
      await route.fulfill({response,body,headers:{...response.headers(),'content-type':'text/javascript'}});
    });
    writeFileSync(join(out,'count-patches.json'),JSON.stringify(patches,null,2));
  }
  const conversation = { id: 'interaction-latency', nextLaunch: { agent: 'claude', values: {} }, busy: false, earlier: null, resets: [], context: null, autoReset: { tokens: 200_000, percent: 50 },
    turns: Array.from({ length: 40 }, (_, i) => ({ id: `turn-${i}`, at: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString(),
      ask: `Measured request ${i} about T2 and T3`, attachments: [], status: 'succeeded', waiting: false, seen: true, error: null, result: null,
      answer: Array.from({ length: i === 39 ? Number(args.paragraphs) : 2 }, (_, n) => `### Result ${n}\nT2 continues after T3. **Check** the report and its result.\n\n- First point\n- Second point\n`).join(''),
      answeredAt: new Date(Date.UTC(2026, 9, 1, 0, i, 30)).toISOString() })) };
  if (!args.questions) await page.route('**/api/coordinator', async route => { const reply = await route.fetch(); await route.fulfill({ response: reply, json: { ...await reply.json(), conversation } }); });

  await page.addInitScript(() => {
    const state = (window as any).interaction = { armed: false, start: 0, received: 0, done: 0, last: 0, frames: [] as number[],
      animations: [] as Animation[], loaf: [] as any[], commits: 0, quiet: 0, scrolled: 0, gesture: false, expect: '', previousTask: undefined as string | undefined, collected: false, endProbe: null as unknown };
    const start = (event: Event) => { if (state.armed && !state.start) { state.start = event.timeStamp; state.received = performance.now();
      const target = event.target instanceof Element ? event.target : null;
      (state as any).input = { type: event.type, tag: target?.tagName, grip: !!target?.closest('[data-task-sheet-grab]'), content: !!target?.closest('[data-reader-content]') };
    } };
    document.addEventListener('touchend', event => { if (state.armed && state.start) (state as any).releaseMs = event.timeStamp; }, true);
    document.addEventListener('beforeinput', start, true); document.addEventListener('pointerdown', start, true); document.addEventListener('keydown', start, true); document.addEventListener('wheel', start, true);
    const rect = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function () {
      if (state.armed && state.start && !state.done && this.matches('li[data-row]')) (state as any).rowReads = ((state as any).rowReads ?? 0) + 1;
      return rect.call(this);
    };
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (...values: Parameters<typeof animate>) {
      const motion = animate.apply(this, values);
      if (state.armed) state.animations.push(motion);
      return motion;
    };
    const finite = (motion: Animation) => motion.effect?.getComputedTiming().iterations !== Infinity;
    const captureCSS = (event: Event) => {
      if (state.armed && event.target instanceof Element)
        for (const animation of event.target.getAnimations())
          if (finite(animation) && !state.animations.includes(animation)) state.animations.push(animation);
    };
    document.addEventListener('animationstart', captureCSS, true);
    document.addEventListener('transitionrun', captureCSS, true);
    const frame = (at: number) => {
      if (state.armed && state.start && !state.done) {
        if (state.last) state.frames.push(at - state.last);
        const scrolling = document.querySelector((state as any).scrollSelector || '[data-coordinator-panel] [data-card-scroll]')?.scrollTop ?? 0;
        const moved = scrolling !== state.scrolled; state.scrolled = scrolling;
        const target = state.expect === 'custom' ? (state as any).completion() : state.expect === 'input-open' ? !!document.querySelector('[data-one-input]')
          : state.expect === 'input-close' ? !document.querySelector('[data-one-input]')
          : state.expect === 'chat-open' ? !!document.querySelector('[data-coordinator-panel]')
          : state.expect === 'chat-close' ? !document.querySelector('[data-coordinator-panel]')
          : state.expect === 'history-open' ? !document.querySelector('[data-earlier]') && document.querySelectorAll('[data-coordinator-message]').length === 40
          : state.expect === 'task-switch' ? document.querySelector('[data-reader-task-id]')?.textContent !== state.previousTask && !!document.querySelector('[data-history-ready="true"]')
          : state.expect === 'detail-open' ? !!document.querySelector('[data-reader-content]') && !!document.querySelector('[data-history-ready="true"]')
          : state.expect === 'detail-close' ? !document.querySelector('[data-reader-content]')
          : state.expect === 'detail-resize' ? !!document.querySelector('[data-sheet]:not([data-sheet-held])')
          : true;
        // animationstart fires after a CSS delay. Inventory once when the target DOM first exists,
        // so delayed rise animations cannot be missed by the quiet-frame completion check.
        if(target && !(state as any).semanticAt)(state as any).semanticAt=performance.now();
        if (target && !state.collected) {
          state.collected = true;
          for (const animation of document.getAnimations())
            if (finite(animation) && !state.animations.includes(animation)) state.animations.push(animation);
        }
        const active = state.gesture || (state.expect === 'scroll' || (state as any).scrollSelector) && moved || state.animations.some((animation: Animation) =>
          (animation.pending || animation.playState === 'running') && finite(animation));
        state.quiet = !active && target ? state.quiet + 1 : 0;
        if (state.quiet >= 3 && at - state.start >= 80) {
          state.done = at;
          state.endProbe = { rafAt: at, observedNow: performance.now(), animations: state.animations.map((a: Animation) => ({
            state: a.playState, pending: a.pending, currentTime: a.currentTime, startTime: a.startTime, timelineTime: a.timeline?.currentTime,
          })) };
        }
      }
      state.last = at;
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    new PerformanceObserver(list => { for (const entry of list.getEntries() as any[]) state.loaf.push({ start: entry.startTime, duration: entry.duration, blocking: entry.blockingDuration, scripts: entry.scripts?.map((s:any)=>({invoker:s.invoker,sourceURL:s.sourceURL,sourceFunctionName:s.sourceFunctionName,sourceCharPosition:s.sourceCharPosition,duration:s.duration,forcedStyleAndLayoutDuration:s.forcedStyleAndLayoutDuration})),renderStart:entry.renderStart,styleAndLayoutStart:entry.styleAndLayoutStart }); })
      .observe({ type: 'long-animation-frame', buffered: false });
    Object.defineProperty(window, '__REACT_DEVTOOLS_GLOBAL_HOOK__', { value: { renderers: new Map(), supportsFiber: true, isDisabled: false, checkDCE() {},
      inject() { return 1; }, onCommitFiberRoot() { state.commits++; }, onCommitFiberUnmount() {}, onPostCommitFiberRoot() {}, onScheduleFiberRoot() {} } });
  });
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: Number(args.throttle) });
  const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(row => [row.name, row.value]));
  await page.goto(url + ((args.detail || args.catalog || args.inventory || args['list-scene']) ? '/?agent=1' : '/?agent=1&task=T2'));
  await page.locator('[data-read]').first().waitFor();
  await page.waitForTimeout(1500);
  if (args['expanded-list']) {
    for (const more of await page.locator('[data-group-more] button').all()) await more.click();
    const done = page.locator('[data-section=done] button');
    if (await done.count()) await done.click();
    await page.waitForTimeout(1500);
  }
  const measure = async (name: string, expect: string, action: () => Promise<unknown>, completion?: string) => {
    const capture=!!args.profile && (!args['profile-only'] || args['profile-only'].split(',').includes(name.replace(/-\d+$/,'')));
    await gate('ready', name);
    await page.waitForTimeout(300);
    const before = await metrics();
    if(args['count-patches'])await page.evaluate(()=>{(window as any).__counts={};});
    await page.evaluate(expect => Object.assign((window as any).interaction, { armed: true, semanticAt:0, start: 0, received: 0, done: 0, frames: [], loaf: [], commits: 0, quiet: 0, collected: false, endProbe: null, gesture: false, releaseMs: 0, rowReads: 0, gestureFrom: null, input: null, scrolled: 0, previousTask: document.querySelector('[data-reader-task-id]')?.textContent, expect, animations: document.getAnimations().filter(a => a.effect?.getComputedTiming().iterations !== Infinity) }), expect);
    await page.evaluate(source => { (window as any).interaction.completion = new Function('return ('+(source || 'true')+')'); }, completion);
    if (capture) { await cdp.send('Tracing.start',{categories:'devtools.timeline,disabled-by-default-devtools.timeline',transferMode:'ReturnAsStream'}); await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 500 }); await cdp.send('Profiler.start'); }
    try { await action(); await page.waitForFunction(() => (window as any).interaction.done > 0); }
    catch(error) { await page.screenshot({path:join(out,name+'-failure.png')});writeFileSync(join(out,name+'-failure.json'),JSON.stringify(await page.evaluate(()=>({state:(window as any).interaction,text:document.body.innerText})),null,2));throw error; }
    const after = await metrics();
    await page.waitForTimeout(100); // Let the observer deliver the last frame; done time is already fixed.
    const observation = await page.evaluate(() => {
      const p = (window as any).interaction; p.armed = false;
      return { counts:(window as any).__counts, elapsedMs: p.endProbe.observedNow - p.start, semanticMs:p.semanticAt ? p.semanticAt-p.start:null, input: p.input, gestureFrom: p.gestureFrom, gestureTo: (() => { const el = document.querySelector('[data-sheet] aside[data-reader-mode=sheet]')?.parentElement; if (!el) return null; const rect = el.getBoundingClientRect(); return { top: rect.top, height: rect.height, scrollTop: el.querySelector('[data-reader-content]')?.scrollTop }; })(), releaseMs: p.releaseMs, releaseToEndMs: p.releaseMs ? p.endProbe.observedNow - p.releaseMs : undefined, inputDelayMs: p.received - p.start, startMs: p.start, doneMs: p.done, endProbe: p.endProbe, frames: p.frames, rowReads: p.rowReads, commits: p.commits, priorFrameMs: p.frames[0],
        task: document.querySelector('[data-reader-task-id]')?.textContent, messages: document.querySelectorAll('[data-coordinator-message]').length,
        leadingLoaf: p.loaf.filter((entry: any) => entry.start < p.start && entry.start + entry.duration >= p.start),
        loaf: p.loaf.filter((entry: any) => entry.start + entry.duration >= p.start && entry.start <= p.done),
        animations: p.animations.map((a: Animation) => ({ duration: a.effect?.getTiming().duration, timing: a.effect?.getTiming(), frames: (a.effect as KeyframeEffect)?.getKeyframes(), state: a.playState })) };
    });
    if (name.includes('detail-body-') && (!observation.input?.content || observation.input?.grip)) throw new Error('Native press did not reach the reading content');
    if (expect === 'detail-resize' && (!observation.gestureTo || !observation.gestureFrom || Math.abs(observation.gestureFrom.height - observation.gestureTo.height) < 40)) throw new Error('Gesture did not resize the sheet');
    if (capture) { const traced=new Promise<any>(done=>cdp.once('Tracing.tracingComplete',done)); await cdp.send('Tracing.end'); const stream=(await traced).stream; let trace=''; for (;;) {const chunk=await cdp.send('IO.read',{handle:stream}); trace+=chunk.data;if(chunk.eof)break;} await cdp.send('IO.close',{handle:stream});writeFileSync(join(out,name+'.trace.json'),trace); const profile = await cdp.send('Profiler.stop'); writeFileSync(join(out, name + '.cpuprofile'), JSON.stringify(profile.profile)); await cdp.send('Profiler.disable'); }
    const delta = (key: string) => ((after[key] ?? 0) - (before[key] ?? 0)) * 1000;
    const resources=await page.evaluate(({start,end})=>performance.getEntriesByType('resource').filter(e=>e.startTime<=end && e.startTime+(e.duration||0)>=start).map((e:any)=>({name:e.name,start:e.startTime,duration:e.duration,bytes:e.transferSize})),{start:observation.startMs,end:observation.endProbe.observedNow});
    const row = { name, metricsWindow:{before,after}, completion:completion||expect, resources, hostLoad: loadavg(), ...observation, frameMaxMs: Math.max(0, ...observation.frames), lateFrames: observation.frames.filter((n: number) => n > 25).length,
      missedFrames: observation.frames.reduce((n: number, ms: number) => n + Math.max(0, Math.round(ms / 16.67) - 1), 0),
      blockingMs: observation.loaf.reduce((n: number, entry: any) => n + entry.blocking, 0),
      scriptMs: delta('ScriptDuration'), layoutMs: delta('LayoutDuration'), styleMs: delta('RecalcStyleDuration'), errors: [...errors] };
    results.push(row); save(); console.log(name, Math.round(row.elapsedMs), 'ms', row.lateFrames, 'late', Math.round(row.frameMaxMs), 'max');
    await gate('done', name);
  };
  const tap = async (where: Locator) => { const box = await where.boundingBox(); if (!box) throw new Error('Missing tap target'); if (box.y + box.height / 2 < 0 || box.y + box.height / 2 >= Number(args.height)) throw new Error('Tap target outside viewport'); const good=await where.evaluate(el=>{const b=el.getBoundingClientRect();const hit=document.elementFromPoint(b.x+b.width/2,b.y+b.height/2);return hit===el||!!hit&&el.contains(hit);});if(!good)throw Error('Tap target occluded'); await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2); };
  if (args.inventory || args.catalog || args.questions || args['list-scene']) {
    await page.screenshot({path:join(out,'entry.png')});
    writeFileSync(join(out,'entry-dom.json'), JSON.stringify(await page.evaluate(()=>({text:document.body.innerText,buttons:[...document.querySelectorAll('button,select,input,summary')].map(el=>({tag:el.tagName,text:el.textContent,attrs:[...el.attributes].filter(a=>a.name.startsWith('data-')||a.name.startsWith('aria-')).map(a=>[a.name,a.value]),rect:el.getBoundingClientRect().toJSON()}))})),null,2));
  }
  if (args.inventory) {
  } else if (args.catalog) {
    const settle=async()=>{await page.waitForTimeout(500);await page.waitForFunction(()=>!document.getAnimations().some(a=>a.effect?.getComputedTiming().iterations!==Infinity&&(a.pending||a.playState==='running')));};
    const home=async()=>{await page.goto(url+'/?agent=1');await page.locator('[data-read]').first().waitFor();await settle();};
    const custom=async(name:string,action:()=>Promise<unknown>,complete:string)=>measure(name,'custom',action,complete);
    for(let i=0;i<Number(args.rounds);i++) {
      await home();
      // Only the Time switch's press is measured; reaching it in the bar's menu and leaving the menu are not.
      const time=await stripsSwitch(page,tap);
      await custom(`timeline-show-${i}`,()=>tap(time),`${STRIPS_SHOWN}==='true' && !!document.querySelector('[data-time-clock]') && !!document.querySelector('[data-timeline-read]')`);
      await leaveBarMenu(page,tap);
      await page.screenshot({path:join(out,`timeline-${i}.png`)});
      await stripsSwitch(page,tap);
      await custom(`timeline-hide-${i}`,()=>tap(time),`${STRIPS_SHOWN}==='false' && !document.querySelector('[data-time-clock]')`);
      await leaveBarMenu(page,tap);
      await custom(`search-open-${i}`,()=>tap(page.locator('[data-search-toggle]')),`!!document.querySelector('[data-search-row]')`);
      const search=page.locator('[data-search-row] input');await search.focus();
      await custom(`search-query-${i}`,()=>page.keyboard.insertText('Synthetic task 17'),`document.querySelector('[data-search-row] input')?.value==='Synthetic task 17' && new URL(location.href).searchParams.get('q')==='Synthetic task 17' && !!document.querySelector('[data-result]') && !document.querySelector('[data-results-head] [role=status]')`);
      await page.screenshot({path:join(out,`search-${i}.png`)});
      await custom(`search-close-${i}`,()=>tap(page.locator('[data-search-toggle]')),`!document.querySelector('[data-search-row]') && !!document.querySelector('[data-time-tree]')`);
      if(args['search-only']) continue;
      await custom(`project-menu-${i}`,()=>tap(page.locator('[data-project-trigger]')),`!!document.querySelector('[data-project-item]')`);
      // One empty project added to the copy permits a real all-to-P1 filter switch. Base perf data stays intact.
      await custom(`project-select-${i}`,()=>tap(page.locator('[data-project-item=P1]')),`!document.querySelector('[data-project-item]') && new URL(location.href).searchParams.get('project')==='P1' && !!document.querySelector('[data-time-tree]')`);
      const gear=await settingsEntry(page,tap);
      await custom(`settings-open-${i}`,()=>tap(gear),`!!document.querySelector('[role=dialog]') && !!document.querySelector('[role=tab]')`);
      // The first tab holding the config.yaml draft is found by its first save row, not by its place, so a run before and after the
      // tabs were reordered measures the same move: another tab shown, then the draft's tab opened. Its panel stays
      // mounted while hidden, so the row is there to find once config.yaml has been read.
      await page.waitForSelector('[role=dialog] [data-settings-foot]',{state:'attached'});
      const draft=await page.evaluate(()=>{const panel=document.querySelector('[data-settings-foot]')!.closest('[role=tabpanel]')!;return [...document.querySelectorAll('[role=dialog] [role=tab]')].findIndex(tab=>tab.getAttribute('aria-controls')===panel.id);});
      if(draft<0) throw new Error('No tab for the settings draft');
      const tabs=page.locator('[role=dialog] [role=tab]'); await tap(tabs.nth(draft===0?1:0)); await settle();
      await custom(`settings-draft-tab-${i}`,()=>tap(tabs.nth(draft)),`[...document.querySelectorAll('[role=dialog] [role=tab]')][${draft}]?.getAttribute('aria-selected')==='true' && !!document.querySelector('[data-settings-foot]')?.checkVisibility()`);
      await page.screenshot({path:join(out,`settings-${i}.png`)});
      await custom(`settings-close-${i}`,()=>page.keyboard.press('Escape'),`!document.querySelector('[role=dialog]')`);
      const done=page.locator('[data-section=done] button'); await done.scrollIntoViewIfNeeded();await settle();
      await custom(`finished-expand-${i}`,()=>tap(done),`document.querySelector('[data-section=done] button')?.getAttribute('aria-expanded')==='true' && !!document.querySelector('[data-time-shelved]')`);
      await page.screenshot({path:join(out,`expanded-${i}.png`)});
      const more=page.locator('[data-group-more] button').first();
      if(await more.count()) {
        await more.scrollIntoViewIfNeeded();await settle(); const n=await page.locator('li[data-row]').count();
        await custom(`list-more-${i}`,()=>tap(more),`document.querySelectorAll('li[data-row]').length>${n}`);
      } else appendFileSync(join(out,'unmeasured.txt'),'list More absent round '+i+'\n');
      await done.scrollIntoViewIfNeeded();await settle();
      await custom(`finished-collapse-${i}`,()=>tap(done),`document.querySelector('[data-section=done] button')?.getAttribute('aria-expanded')==='false' && !document.querySelector('[data-time-shelved]')`);
      await home();
      const area=page.locator('[data-time-tree]');const b=await area.boundingBox(); if(!b)throw Error('No list');
      const dimensions=await area.evaluate(el=>({scroll:el.scrollHeight,client:el.clientHeight}));
      if(dimensions.scroll-dimensions.client<100){appendFileSync(join(out,'unmeasured.txt'),'home-list-scroll: no overflow '+JSON.stringify(dimensions)+' round '+i+'\n');continue;}
      const from=await area.evaluate(el=>el.scrollTop);
      await page.evaluate(()=>{(window as any).interaction.scrollSelector='[data-time-tree]';});
      await custom(`list-scroll-${i}`,async()=>{
        await page.evaluate(()=>{(window as any).interaction.gesture=true;});
        const x=200,y=650;
        await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
        for(let n=1;n<=8;n++){await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:y-350*n/8}]});await page.waitForTimeout(25);}
        await page.waitForTimeout(160);
        await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
        await page.evaluate(()=>{(window as any).interaction.gesture=false;});
      },`document.querySelector('[data-time-tree]').scrollTop>${from}+100`);
      await page.evaluate(()=>{(window as any).interaction.scrollSelector='';});
    }
  } else if (args['list-scene']) {
    const more=page.locator('[data-group-more=review] button');const area=page.locator('[data-time-tree]');
    for(let i=0;i<Number(args.rounds);i++) {
      if(i){await page.goto(url+'/?agent=1');await more.waitFor();await page.waitForTimeout(1000);}
      await more.scrollIntoViewIfNeeded();await page.waitForTimeout(500);const before=await page.locator('li[data-row]').count();
      await measure(`list-more-${i}`,'custom',()=>tap(more),`document.querySelector('[data-group-more=review] button')?.getAttribute('aria-expanded')==='true' && document.querySelectorAll('li[data-row]').length>${before}`);
      await page.screenshot({path:join(out,`more-${i}.png`)});
      await area.evaluate(el=>{el.scrollTop=0});await page.waitForTimeout(500);const from=await area.evaluate(el=>el.scrollTop);
      await page.evaluate(()=>{(window as any).interaction.scrollSelector='[data-time-tree]';});
      await measure(`list-scroll-${i}`,'custom',async()=>{
        await page.evaluate(()=>{(window as any).interaction.gesture=true;});
        const x=200,y=650;
        await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
        for(let n=1;n<=8;n++){await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:y-350*n/8}]});await page.waitForTimeout(25);}
        await page.waitForTimeout(160);await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
        await page.evaluate(()=>{(window as any).interaction.gesture=false;});
      },`document.querySelector('[data-time-tree]').scrollTop>${from}+100`);
      await page.evaluate(()=>{(window as any).interaction.scrollSelector='';});
      await more.scrollIntoViewIfNeeded();await page.waitForTimeout(500);
      await measure(`list-less-${i}`,'custom',()=>tap(more),`document.querySelector('[data-group-more=review] button')?.getAttribute('aria-expanded')==='false' && document.querySelectorAll('li[data-row]').length<=${before}`);
    }
  } else if (args.questions) {
    // The fake coordinator performs real local command writes, never a provider call.
    await tap(page.locator('[data-coordinator-expand]').first());
    const readyLimit = Date.now() + 30_000;
    let snapshot: any;
    while (Date.now() < readyLimit) {
      snapshot = await fetch(url + '/api/coordinator').then(response => response.json());
      if (snapshot.conversation?.nextLaunch && !snapshot.conversation.busy) break;
      await page.waitForTimeout(100);
    }
    if (!snapshot.conversation?.nextLaunch || snapshot.conversation.busy) throw Error('Fixture coordinator is unavailable');
    writeFileSync(join(out, 'coordinator-ready.json'), JSON.stringify(snapshot, null, 2));
    await page.waitForTimeout(500);
    await foldChat(page, tap); await page.keyboard.press('Escape'); await page.waitForTimeout(500);
    const custom=async(name:string,action:()=>Promise<unknown>,complete:string)=>measure(name,'custom',action,complete);
    for(let i=0;i<(args['messages-only'] ? 0:Math.min(Number(args.rounds),questionIds.length));i++) {
      const id=questionIds[i]!; await page.goto(url+'/?agent=1&task='+id);await page.locator('[data-history-ready=true]').waitFor();await page.waitForTimeout(1000);
      const choice=page.locator('[data-question="1"] button').first();await choice.scrollIntoViewIfNeeded();await page.waitForTimeout(500);
      await page.screenshot({path:join(out,`question-${i}.png`)});
      await custom(`question-choice-${i}`,()=>tap(choice),`document.querySelector('[data-question="1"] button')?.getAttribute('aria-pressed')==='true'`);
      if(!await page.locator('[data-one-input]').count()){await tap(page.locator('[data-coordinator-write]'));await page.waitForTimeout(500);}
      const editor=page.locator('[data-one-input]');await editor.focus();
      const text='青で進めてください '+i;
      await custom(`input-text-${i}`,()=>page.keyboard.insertText(text),`document.querySelector('[data-one-input]')?.textContent.includes(${JSON.stringify(text)})`);
      await page.evaluate(()=>{(window as any).interaction.answerSaved=false;});
      await custom(`answer-send-${i}`,async()=>{
        await tap(page.locator('[data-ask-send]'));
        const limit=Date.now()+30000;let saved:any;
        while(Date.now()<limit){saved=await fetch(url+'/api/task/view?task='+id).then(r=>r.json());if(saved.questions?.some((q:any)=>q.id===questionRefs[id]&&q.state==='answered'))break;const coordinator=await fetch(url+'/api/coordinator').then(r=>r.json());const last=coordinator.conversation.turns.at(-1);if(last?.answer){try{const outcome=JSON.parse(last.answer);if(outcome.ok===false)throw Error('Fake coordinator command refused: '+last.answer);}catch(error){if(String(error).includes('command refused'))throw error;}}await page.waitForTimeout(50);}
        writeFileSync(join(out,`answer-saved-${i}.json`),JSON.stringify(saved,null,2));
        if(!saved.questions?.some((q:any)=>q.id===questionRefs[id]&&q.state==='answered'))throw Error('Answer not saved');
        await page.evaluate(()=>{(window as any).interaction.answerSaved=true;});
      },`(window.interaction.answerSaved) && !document.querySelector('[data-one-input]') && (document.querySelector('[data-reader-task-id]')?.textContent!==${JSON.stringify(id)} || !!document.querySelector('[data-answered-count]'))`);

    }
    await page.goto(url+'/?agent=1');await page.locator('[data-read]').first().waitFor();await page.waitForTimeout(800);
    await tap(page.locator('[data-coordinator-expand]').first());await page.locator('[data-coordinator-panel]').waitFor();await page.waitForTimeout(800);
    for(let i=0;i<Number(args.rounds);i++) {
      const text='Synthetic conversation message '+i;await page.locator('[data-one-input]').focus();await page.keyboard.press('Control+a');await page.keyboard.press('Backspace');await page.keyboard.insertText(text);await page.waitForTimeout(300);
      await page.evaluate(()=>{(window as any).interaction.sendSaved=false;});
      await custom(`conversation-send-${i}`,async()=>{
        await tap(page.locator('[data-ask-send]'));
        const limit=Date.now()+10000;let snapshot:any;
        while(Date.now()<limit){snapshot=await fetch(url+'/api/coordinator').then(r=>r.json());if(snapshot.conversation.turns.some((t:any)=>t.ask===text))break;await page.waitForTimeout(50);}
        writeFileSync(join(out,`message-saved-${i}.json`),JSON.stringify(snapshot,null,2));
        if(!snapshot.conversation.turns.some((t:any)=>t.ask===text))throw Error('Conversation message not saved');
        await page.evaluate(()=>{(window as any).interaction.sendSaved=true;});
      },`window.interaction.sendSaved && [...document.querySelectorAll('[data-coordinator-turn] [data-sent-message]')].some(el=>el.textContent.includes(${JSON.stringify(text)}))`);
      await page.waitForTimeout(1000);
    }
  } else if (args.detail) {
    const row = page.locator('[data-read]').first();
    const task = await row.getAttribute('data-read');
    const live = page.locator('[data-sheet]').filter({ has: page.locator('aside[data-reader-mode=sheet]') });
    const resetShare = () => page.evaluate(() => {
      localStorage.setItem('alpacawork.sheetHeight', String(2 / 3));
      dispatchEvent(new StorageEvent('storage', { key: 'alpacawork.sheetHeight' }));
    });
    const reopen = async () => { await resetShare(); await tap(row); await page.waitForTimeout(900); };
    const close = () => tap(live.locator('[data-reader-frame-buttons] button:last-child'));
    const pull = async (part: 'handle' | 'body', close: boolean) => {
      const box = await live.boundingBox(); if (!box) throw new Error('No live sheet');
      const area = part === 'handle' ? await live.locator('[data-task-sheet-grip]').boundingBox() : await live.locator('[data-reader-content]').boundingBox();
      if (!area) throw new Error('No gesture target');
      const x = part === 'handle' ? area.x + area.width / 2 : area.x + area.width - 8;
      const y = part === 'handle' ? area.y + area.height / 2 : await live.evaluate(el => {
        const content = el.querySelector('[data-reader-content]')!, header = el.querySelector('[data-reader-header]')!, title = el.querySelector('[data-head-title]');
        return Math.max(content.getBoundingClientRect().top, header.getBoundingClientRect().bottom, title?.getBoundingClientRect().bottom ?? 0) + 16;
      });
      const hit = await page.evaluate(({ x, y }) => { const at = document.elementFromPoint(x, y); return { content: !!at?.closest('[data-reader-content]'), grip: !!at?.closest('[data-task-sheet-grab]') }; }, { x, y });
      if (part === 'body' && (!hit.content || hit.grip)) throw new Error('Body point is covered by a grip or header');
      const travel = close ? Math.min(500, Number(args.height) - y - 8) : 100;
      await page.evaluate(box => { Object.assign((window as any).interaction, { gesture: true, gestureFrom: { top: box.y, height: box.height, scrollTop: document.querySelector('[data-reader-content]')?.scrollTop } }); }, box);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      for (let n = 1; n <= 8; n++) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + travel * n / 8 }] });
        await page.waitForTimeout(30);
      }
      if (!close) await page.waitForTimeout(180);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await page.evaluate(() => { const p = (window as any).interaction; p.gesture = false; });
    };
    await measure('warm-detail-open', 'detail-open', () => tap(row));
    await measure('warm-detail-close', 'detail-close', close);
    for (let i = 0; i < Number(args.rounds); i++) {
      await resetShare();
      await measure(`detail-open-${i}`, 'detail-open', () => tap(row));
      if (await live.locator('[data-reader-task-id]').textContent() !== task) throw new Error('Wrong task');
      await page.screenshot({ path: join(out, `detail-open-${i}.png`) });
      await measure(`detail-close-button-${i}`, 'detail-close', close);
      await reopen();
      await measure(`detail-close-back-${i}`, 'detail-close', async () => { await page.evaluate(() => { const p = (window as any).interaction; p.start = performance.now(); p.received = p.start; p.input = { type: 'browser-history-command' }; }); await page.goBack(); });
      for (const part of ['handle', 'body'] as const) {
        await reopen();
        await measure(`detail-${part}-resize-${i}`, 'detail-resize', () => pull(part, false));
        await page.screenshot({ path: join(out, `detail-${part}-resize-${i}.png`) });
        await measure(`detail-${part}-close-${i}`, 'detail-close', () => pull(part, true));
      }
    }
  } else {
  // Warm the conversation/catalog outside the measured repeat windows.
  await measure('warm-chat-open', 'chat-open', () => tap(page.locator('[data-coordinator-expand]').first()));
  await measure('warm-chat-close', 'chat-close', () => foldChat(page, tap));
  await page.waitForTimeout(500); await page.keyboard.press('Escape'); await page.waitForTimeout(500);
  await measure('warm-input-open', 'input-open', () => tap(page.locator('[data-coordinator-write]')));
  await measure('warm-input-close', 'input-close', () => page.keyboard.press('Escape'));
  for (let i = 0; i < Number(args.rounds); i++) {
    await measure(`input-open-${i}`, 'input-open', () => tap(page.locator('[data-coordinator-write]')));
    await measure(`input-close-${i}`, 'input-close', () => page.keyboard.press('Escape'));
    await measure(`chat-open-${i}`, 'chat-open', () => tap(page.locator('[data-coordinator-expand]').first()));
    await page.screenshot({ path: join(out, `opened-${i}.png`) });
    await page.locator('[data-earlier] button').scrollIntoViewIfNeeded();
    await measure(`history-open-${i}`, 'history-open', () => tap(page.locator('[data-earlier] button')));
    await page.screenshot({ path: join(out, `history-${i}.png`) });
    const scroll = page.locator('[data-coordinator-panel] [data-card-scroll]');
    await scroll.evaluate(el => { el.scrollTop = 0; });
    await page.waitForTimeout(300);
    const from = await scroll.evaluate(el => el.scrollTop);
    const box = await scroll.boundingBox(); if (!box) throw new Error('No conversation scroll area');
    await measure(`chat-scroll-${i}`, 'scroll', async () => {
      await page.evaluate(() => { (window as any).interaction.gesture = true; });
      const x = box.x + box.width / 2, y = box.y + box.height * 0.8;
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      for (let n = 1; n <= 8; n++) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - Math.min(240, box.height * 0.55) * n / 8 }] });
        await page.waitForTimeout(20);
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await page.evaluate(() => { (window as any).interaction.gesture = false; });
    });
    if (Math.abs(await scroll.evaluate(el => el.scrollTop) - from) < 20) throw new Error('Gesture did not scroll');
    await page.screenshot({ path: join(out, `open-${i}.png`) });
    await measure(`chat-close-${i}`, 'chat-close', () => foldChat(page, tap));
    await measure(`input-fold-${i}`, 'input-close', () => page.keyboard.press('Escape'));
  }
  await page.screenshot({ path: join(out, 'folded.png') });
  const next = page.locator('[data-list-next]');
  if (!await next.isEnabled()) throw new Error('Fixture has no next task');
  for (let i = 0; i < Number(args.rounds); i++) {
    await measure(`task-next-${i}`, 'task-switch', () => tap(next));
    await measure(`task-previous-${i}`, 'task-switch', () => tap(page.locator('[data-list-previous]')));
  }
  }
  if (errors.length) throw new Error('Browser errors: ' + errors.join('; '));
  await context.close();
} catch(error) {
  const failedPage=browser?.contexts()[0]?.pages()[0];
  if(failedPage){await failedPage.screenshot({path:join(out,'failure.png')}).catch(()=>{});writeFileSync(join(out,'failure-dom.txt'),await failedPage.locator('body').innerText().catch(()=>''));}
  writeFileSync(join(out,'failure.txt'),String((error as Error).stack)); cpSync(root,join(out,'failure-workspace'),{recursive:true}); throw error;
} finally {
  writeFileSync(join(out,'process-tree-end.txt'),processes());
  if(child.exitCode===null){const stateStore=new ControlStore(root,{busyTimeoutMs:1000},true);try{writeFileSync(join(out,'fixture-end-state.json'),JSON.stringify(stateStore.read(db=>({counts:Object.fromEntries(['tasks','task_log','runs','requests','placements'].map(table=>[table,db.prepare('SELECT count(*) n FROM '+table).get()!.n])),states:db.prepare('SELECT state,count(*) n FROM tasks GROUP BY state').all()})),null,2));}finally{stateStore.close();}}
  process.off('disconnect', disconnected);
  process.off('SIGTERM', disconnected);
  process.off('SIGINT', disconnected);
  clearTimeout(expiry); await browser?.close();
  if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); }
  save(); removeWorkspace(root); writeFileSync(join(out,'stopped.json'),JSON.stringify({at:new Date().toISOString(),runner:process.pid,server:child.pid,serverExit:child.exitCode,signal:child.signalCode,browserConnected:browser?.isConnected(),workspaceRemoved:true},null,2));
  if (process.connected) process.disconnect();
}
