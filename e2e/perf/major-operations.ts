/** Manual baseline only. Normal build, no performance assertions, no test registration. */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { cpus, loadavg, totalmem } from 'node:os';
import { chromium, type Browser, type Page, type CDPSession, type Locator } from '@playwright/test';
import { createOriginal, copyWorkspace, removeWorkspace, profiles } from '../../scripts/dev-fixtures/fixture.ts';
import { configureCoordinator } from '../coordinator-fixture.ts';
import { startPackagedServer } from './packaged-server.ts';

const { values: args } = parseArgs({ options: { out: {type:'string'}, profile:{type:'boolean',default:false}, trace:{type:'boolean',default:false}, invalidation:{type:'boolean',default:false}, 'backend-profile':{type:'boolean',default:false}, 'before-build':{type:'string'}, 'after-build':{type:'string'}, devices:{type:'string',default:'pc,phone'}, profiles:{type:'string',default:'perf,small'}, rounds: {type:'string',default:'3'} } });
if (!args.out) throw Error('--out <new directory> required');
if (args.invalidation && !args.trace) throw Error('--invalidation requires --trace');
if (args.trace && !args.profile) throw Error('--trace requires a separate --profile run');
const out=resolve(args.out), release=resolve('.'), rounds=Number(args.rounds);
if (!Number.isInteger(rounds)||rounds<1) throw Error('rounds must be positive');
const paired=!!args['before-build']&&!!args['after-build'];
if(!!args['before-build']!==!!args['after-build'] || paired&&(args.profile||args.profiles!=='perf'))throw Error('Paired builds require both paths, --profiles perf, and no --profile');
const runtimePaths=['apps/backend/dist','apps/backend/public','apps/cli/dist','apps/agent-cli/dist',...readdirSync(join(release,'packages')).filter(name=>existsSync(join(release,'packages',name,'dist'))).map(name=>'packages/'+name+'/dist')];
const copyBuild=(from:string,to:string,replace=false)=>{for(const path of runtimePaths){const target=join(to,path);if(replace)rmSync(target,{recursive:true,force:true});mkdirSync(join(target,'..'),{recursive:true});cpSync(join(from,path),target,{recursive:true});}};
mkdirSync(out); // Refuse overwriting a previous result.
const result:any={profile:args.profile,trace:args.trace,invalidation:args.invalidation,sha:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(), release, capturedAt:new Date().toISOString(),
  environment:{node:process.version,platform:process.platform,arch:process.arch,cpu:cpus()[0]?.model,logicalCPUs:cpus().length,hostMemoryBytes:totalmem(),loadBefore:loadavg()},
  definitions:{semantic:'First RAF observing the first 16px of target text/row inside viewport and clipping ancestors; not animation completion. List uses Navigation Timing start; clicks use native pointerdown Event.timeStamp. Send requires successful POST receipt and visible sent text.',
    cpu:'CDP TaskDuration with threadTicks ms (renderer main-thread CPU, excludes GPU/other browser processes). Navigation resets counters: list uses post-navigation absolute; clicks use delta. Not physical system CPU; Linux /proc server process utime+stime delta ms, excludes children.',
    memory:'CDP JSHeapUsedSize and /proc RSS MB (decimal), sampled before/after, no GC forcing or strict peak.',
    windows:'Resource samples bracket input dispatch through observed semantic completion plus CDP/IPC observation overhead. Motion time is a separate boundary.',
    history:'Open a collapsed row in the already loaded T2 History and display its body; not fetching all historical pages.',
    list:'Document navigation to list, warm browser HTTP/OS cache; no existing SPA state. Warm-up separate.',
    project:'All-project list to populated P1 via menu item; add 1 empty project so real picker switching is available.',
    emulation:'Desktop Chromium: PC 1440x900 CPU1; phone 390x900 DPR3 mobile/touch CPU4. Not a real phone.'},
  fixtures:[],integrity:[],samples:[],errors:[],lifecycle:{runnerPid:process.pid,deadline:new Date(Date.now()+30*60_000).toISOString(),servers:[]}};
const originalRoots:string[]=[];
if(paired)copyBuild(release,join(out,'restore-build'));
const editions=paired?[{name:'before',path:resolve(args['before-build']!)},{name:'after',path:resolve(args['after-build']!)}]:[{name:'current',path:release}];
result.editions=editions.map(e=>({...e,indexSha256:createHash('sha256').update(readFileSync(join(e.path,'apps/backend/public/index.html'))).digest('hex')}));
let edition='current',trial=0;
let browser:Browser|undefined, server:Awaited<ReturnType<typeof startPackagedServer>>|undefined, root:string|undefined;
const save=()=>writeFileSync(join(out,'results.json'),JSON.stringify(result,null,2)+'\n');
let interrupted=false;
const shutdown=()=>{interrupted=true;process.exitCode=3;void browser?.close();};
const expiry=setTimeout(shutdown,30*60_000);
process.once('SIGTERM',shutdown);process.once('SIGINT',shutdown);
const ticks=Number(execFileSync('getconf',['CLK_TCK'],{encoding:'utf8'}));
function backend(pid:number){
  try { const stat=readFileSync(`/proc/${pid}/stat`,'utf8').split(') ')[1]!.split(' ');
    const rss=Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`,'utf8'))?.[1])*1024;
    return {at:performance.now(),cpuMs:(Number(stat[11])+Number(stat[12]))*1000/ticks,rssMB:rss/1e6};
  }catch{return null;}
}
function snapshot(path:string){
  const db=new DatabaseSync(join(path,'.alpacawork/alpacawork.sqlite'),{readOnly:true});
  try {db.exec('BEGIN');return Object.fromEntries(['tasks','task_log','runs','requests','returns','placements'].map(table=>{
    const rows=db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
    return [table,{count:rows.length,sha256:createHash('sha256').update(JSON.stringify(rows)).digest('hex')}];
  }));}finally{db.close();}
}
async function metrics(cdp:CDPSession){const at=performance.now();const m=await cdp.send('Performance.getMetrics');return {at,values:Object.fromEntries(m.metrics.map(x=>[x.name,x.value]))};}
async function install(page:Page){await page.addInitScript(trace=>{
  const w=window as any;w.probe={armed:false};
  document.addEventListener('pointerdown',e=>{if(w.probe.armed&&!w.probe.start){w.probe.start=e.timeStamp;w.probe.received=performance.now();w.probe.inputTarget=(e.target as Element)?.outerHTML.slice(0,500);}},true);
  const visible=(selector:string|Element)=>{
    const el=typeof selector==='string'?document.querySelector(selector):selector;if(!el)return false;
    const r=el.getBoundingClientRect();let left=Math.max(0,r.left),right=Math.min(innerWidth,r.right),top=Math.max(0,r.top),bottom=Math.min(innerHeight,r.top+Math.min(24,r.height));
    for(let node:Element|null=el;node;node=node.parentElement){
      const style=getComputedStyle(node);if(style.visibility==='hidden'||Number(style.opacity)===0)return false;
      const clip=node.getBoundingClientRect();
      if(/hidden|clip|scroll|auto/.test(style.overflowX)){left=Math.max(left,clip.left);right=Math.min(right,clip.right);}
      if(/hidden|clip|scroll|auto/.test(style.overflowY)){top=Math.max(top,clip.top);bottom=Math.min(bottom,clip.bottom);}
    }
    return right-left>=1&&bottom-top>=Math.min(16,r.height)&&r.height>0;
  };
  w.ready=(t:any)=> (!t.visible||visible(t.visible)) && (!t.exists||!!document.querySelector(t.exists)) && (!t.absent||!document.querySelector(t.absent))
    && (!t.task||document.querySelector('[data-reader-task-id]')?.textContent===t.task)
    && (!t.text||[...document.querySelectorAll(t.textSelector)].some(el=>el.textContent?.includes(t.text)&&visible(el)))
    && (!t.project||new URL(location.href).searchParams.get('project')===t.project) && (!t.receipt||w.receipt);
  function frame(){const p=w.probe;
    if(p.armed&&p.start!==undefined&&p.target?.receipt&&!p.serverText&&w.ready({...p.target,receipt:false}))p.serverText=performance.now();
    if(p.armed&&p.start!==undefined&&!p.semantic&&p.target&&w.ready(p.target)){
      p.semantic=performance.now();if(trace)performance.mark('aw-major-semantic');p.animations=document.getAnimations().filter(a=>a.effect?.getComputedTiming().iterations!==Infinity);
    }
    if(p.semantic&&!p.motion){
      const active=p.animations.some((a:Animation)=>a.pending||a.playState==='running');
      p.quiet=active?0:(p.quiet??0)+1;if(p.quiet>=3)p.motion=performance.now();
    }
    requestAnimationFrame(frame);
  }requestAnimationFrame(frame);
},args.trace);}
async function tap(page:Page,locator:Locator,mobile:boolean){
  const b=await locator.boundingBox();if(!b)throw Error('Input target has no box');
  if(mobile)await page.touchscreen.tap(b.x+b.width/2,b.y+b.height/2);else await page.mouse.click(b.x+b.width/2,b.y+b.height/2);
}
async function nodeProbe(url:string){
  const socket=new WebSocket(url);await new Promise<void>((done,fail)=>{socket.addEventListener('open',()=>done(),{once:true});socket.addEventListener('error',()=>fail(Error('Inspector connection failed')),{once:true});});
  let id=0;const waiting=new Map<number,{resolve:(value:any)=>void;reject:(error:Error)=>void}>();
  socket.addEventListener('message',event=>{const value=JSON.parse(String(event.data)),pending=waiting.get(value.id);if(pending){waiting.delete(value.id);value.error?pending.reject(Error(JSON.stringify(value.error))):pending.resolve(value.result);}});
  return {send:(method:string,params={})=>new Promise<any>((resolve,reject)=>{const current=++id;waiting.set(current,{resolve,reject});socket.send(JSON.stringify({id:current,method,params}));}),close:()=>socket.close()};
}
let backendProbe:Awaited<ReturnType<typeof nodeProbe>>|undefined;
async function measure(page:Page,cdp:CDPSession,name:string,round:number,device:string,target:Record<string,unknown>,action:()=>Promise<unknown>,navigation=false){
  const capture=args.profile&&round===1&&['list','detail'].includes(name);
  if(capture&&args.trace)await cdp.send('Tracing.start',{categories:'devtools.timeline,blink.user_timing,v8,disabled-by-default-devtools.timeline.stack'+(args.invalidation?',disabled-by-default-devtools.timeline.invalidationTracking':''),transferMode:'ReturnAsStream'});
  if(capture&&backendProbe){await backendProbe.send('Profiler.enable');await backendProbe.send('Profiler.setSamplingInterval',{interval:500});await backendProbe.send('Profiler.start');}
  if(capture){await cdp.send('Profiler.enable');await cdp.send('Profiler.setSamplingInterval',{interval:500});await cdp.send('Profiler.start');}
  const a=await metrics(cdp),ba=backend(server!.pid);
  if(!navigation)await page.evaluate(target=>{(window as any).probe={armed:true,target};},target);
  const commandAt=performance.now();
  let acceptance:any=null;
  const receipt=name==='send'?page.waitForResponse(r=>new URL(r.url()).pathname==='/api/coordinator/messages'&&r.request().method()==='POST').then(async r=>{
    acceptance={status:r.status(),observedAt:performance.now(),body:await r.json()};if(!r.ok())throw Error('Send refused '+r.status());
    await page.evaluate(()=>{(window as any).receipt=true;});
  }):null;
  const actionDone=action();if(navigation)await actionDone;
  await page.waitForFunction(()=>!!(window as any).probe.semantic,null,{polling:'raf',timeout:30_000});
  if(receipt)await receipt;
  const semanticObservedAt=performance.now(),b=await metrics(cdp),bb=backend(server!.pid);
  await actionDone;
  if(capture&&backendProbe){const cpu=await backendProbe.send('Profiler.stop');writeFileSync(join(out,device+'-'+name+'-backend.cpuprofile'),JSON.stringify(cpu.profile));}
  await page.waitForFunction(()=>!!(window as any).probe.motion,null,{polling:'raf',timeout:15_000});
  const p=await page.evaluate(()=>{const p=(window as any).probe;return {start:p.start,received:p.received,serverText:p.serverText,semantic:p.semantic,motion:p.motion,timeOrigin:performance.timeOrigin,resources:performance.getEntriesByType('resource').filter(e=>e.startTime>=p.start).map((e:any)=>({name:new URL(e.name).pathname,startTime:e.startTime,duration:e.duration,transferSize:e.transferSize}))};});
  if(capture){const cpu=await cdp.send('Profiler.stop');writeFileSync(join(out,device+'-'+name+'.cpuprofile'),JSON.stringify(cpu.profile));await cdp.send('Profiler.disable');}
  if(capture&&args.trace){
    const complete=new Promise<string>(done=>cdp.once('Tracing.tracingComplete',event=>done(event.stream!)));
    await cdp.send('Tracing.end');const handle=await complete;let data='';
    try{for(;;){const chunk=await cdp.send('IO.read',{handle});data+=chunk.base64Encoded?Buffer.from(chunk.data,'base64').toString('utf8'):chunk.data;if(chunk.eof)break;}}
    finally{await cdp.send('IO.close',{handle});}
    writeFileSync(join(out,device+'-'+name+'-timeline.json'),data);
  }
  const cpuStart=navigation?0:a.values.TaskDuration,cpuEnd=b.values.TaskDuration;
  const sample={edition,trial,device,operation:name,round,warmup:round===0,serverTextMs:p.serverText===undefined?null:p.serverText-p.start,semanticMs:p.semantic-p.start,motionMs:p.motion-p.start,inputDelayMs:p.received===undefined?null:p.received-p.start,
    browserCpuMs:cpuStart===undefined||cpuEnd===undefined?null:(cpuEnd-cpuStart)*1000,jsHeapBeforeMB:a.values.JSHeapUsedSize===undefined?null:a.values.JSHeapUsedSize/1e6,jsHeapAfterMB:b.values.JSHeapUsedSize===undefined?null:b.values.JSHeapUsedSize/1e6,
    backendCpuMs:ba&&bb?bb.cpuMs-ba.cpuMs:null,backendRssBeforeMB:ba?.rssMB??null,backendRssAfterMB:bb?.rssMB??null,
    resourceWindowMs:b.at-a.at,commandToObservedMs:semanticObservedAt-commandAt,raw:{probe:p,browserBefore:a,browserAfter:b,backendBefore:ba,backendAfter:bb,acceptance}};
  result.samples.push(sample);save();console.log(JSON.stringify({...sample,raw:undefined}));
  await page.waitForTimeout(350);
}
try {
  browser=await chromium.launch();result.environment.chromium=browser.version();save();
  for(const profile of args.profiles!.split(',')){
    if(profile!=='perf'&&profile!=='small')throw Error('profiles must be perf,small');
    const original=createOriginal({...profiles[profile],seed:'synthetic-v1'},join(out,'originals'));originalRoots.push(original.root);
    for(const device of args.devices!.split(',')){
      root=join(out,'workspace-'+profile+'-'+device);copyWorkspace(original.root,root);
      if(profile==='small')configureCoordinator(root);
      let prepared=false;
      const trials=paired?Array.from({length:rounds},(_,n)=>(n%2?[...editions].reverse():editions).map(e=>({...e,trial:n+1}))).flat():[{...editions[0]!,trial:0}];
      for(const current of trials){
      edition=current.name;trial=current.trial;
      if(paired)copyBuild(current.path,release,true);
      server=await startPackagedServer(release,root,0,args['backend-profile']);server.url=server.url.replace(/\/$/,'');if(server.inspectorUrl)backendProbe=await nodeProbe(server.inspectorUrl);
      result.lifecycle.servers.push({profile,device,edition,trial,pid:server.pid,url:server.url});save();
      // Let ordinary serve reconciliation finish; do not suppress or rewrite it.
      if(!prepared){
      const settleStart=Date.now();let last=snapshot(root),lastChanged=Date.now();
      while(Date.now()-lastChanged<35_000 && Date.now()-settleStart<240_000){
        await new Promise(r=>setTimeout(r,2500));if(interrupted)throw Error('Measurement interrupted');const next=snapshot(root);
        if(JSON.stringify(last)!==JSON.stringify(next)){lastChanged=Date.now();last=next;}
      }
      result.settling??=[];result.settling.push({profile,device,waitMs:Date.now()-settleStart,stableMs:Date.now()-lastChanged,stable:Date.now()-lastChanged>=35_000});save();
      if(profile==='perf'){
        const r=await fetch(server.url+'/api/commands/task/new',{method:'POST',headers:{'content-type':'application/json','x-alpacawork-op-id':crypto.randomUUID()},body:JSON.stringify({kind:'project',color:'#795548',parent:'none',title:'Synthetic secondary project'})});
        if(!r.ok)throw Error('Cannot add secondary project: '+await r.text());
        result.secondaryProject=await r.json();
      }
      prepared=true;
      }
      result.fixtures.push({profile,device,edition,trial,key:original.key,spec:{...profiles[profile],seed:'synthetic-v1'},modifications:profile==='perf'?'one empty project added through API':'existing configureCoordinator with fake-coordinator-agent; send only, different workload',afterServePreparation:snapshot(root)});
      const mobile=device==='phone';
      const context=await browser.newContext({viewport:{width:mobile?390:1440,height:900},hasTouch:mobile,isMobile:mobile,deviceScaleFactor:mobile?3:1,locale:'en-US',timezoneId:'Asia/Tokyo',serviceWorkers:'block'});
      const page=await context.newPage();page.setDefaultTimeout(20000);await install(page);
      page.on('pageerror',e=>{result.errors.push({device,profile,error:e.stack});save();});
      const cdp=await context.newCDPSession(page);await cdp.send('Performance.enable',{timeDomain:'threadTicks'});await cdp.send('Emulation.setCPUThrottlingRate',{rate:mobile?4:1});
      const before=snapshot(root);const conversationBefore=profile==='small'?await fetch(server.url+'/api/coordinator').then(r=>r.json()):null;
      for(let round=0;round<=(paired?1:rounds);round++){
        if(profile==='perf'){
          // Install a navigation predicate before each document's first frame.
          const listTarget={visible:'[data-read="T2"]',exists:'[data-time-tree]'};
          await page.addInitScript(target=>{(window as any).probe={armed:true,start:0,target};},listTarget);
          await measure(page,cdp,'list',round,device,listTarget,()=>page.goto(server!.url+'/?agent=1',{waitUntil:'domcontentloaded'}),true);
          const row=page.locator('[data-read="T2"]').first();await row.scrollIntoViewIfNeeded();
          await measure(page,cdp,'detail',round,device,{visible:'[data-report-feed] [data-report-key] article > div > button',task:'T2',exists:'[data-history-ready=true]'},()=>tap(page,row,mobile));
          const cards=page.locator('[data-report-key] article > div > button[aria-expanded="false"]');
          const card=cards.first();await card.scrollIntoViewIfNeeded();
          const key=await card.evaluate(el=>el.closest('[data-report-key]')!.getAttribute('data-report-key'));
          const target={visible:`[data-report-key="${key}"] [data-report-card-open=""]`,textSelector:`[data-report-key="${key}"] [data-disclosure-body][data-open="true"] p`,text:'Fictional'};
          await measure(page,cdp,'history',round,device,target,()=>tap(page,card,mobile));
          await page.goto(server.url+'/?agent=1');await page.locator('[data-read="T2"]').first().waitFor();await page.waitForTimeout(350);
          await tap(page,page.locator('[data-project-trigger]'),mobile);await page.locator('[data-project-item="P1"]').waitFor();await page.waitForTimeout(400);
          await measure(page,cdp,'project',round,device,{project:'P1',absent:'[data-project-item]',visible:'[data-read="T2"]'},()=>tap(page,page.locator('[data-project-item="P1"]'),mobile));
        }else{
          await page.goto(server.url+'/?agent=1');await page.locator('[data-read]').first().waitFor();
          await tap(page,page.locator('[data-coordinator-expand]').first(),mobile);await page.locator('[data-one-input]').waitFor();
          await page.waitForTimeout(800);
          const text=`Synthetic baseline message ${round}`;
          await page.locator('[data-one-input]').fill(text);await page.waitForTimeout(300);
          await page.evaluate(()=>{(window as any).receipt=false;});
          await measure(page,cdp,'send',round,device,{receipt:true,textSelector:'[data-coordinator-turn] [data-sent-message]',text},()=>tap(page,page.locator('[data-ask-send]'),mobile));
          // Keep generation/completion work outside subsequent measured sends.
          const doneBy=Date.now()+30_000;
          for(;;){const c:any=await fetch(server.url+'/api/coordinator').then(r=>r.json());if(!c.conversation.busy&&c.conversation.warm!=='preparing')break;if(Date.now()>doneBy)throw Error('Fake coordinator did not finish');await page.waitForTimeout(100);}
          await page.waitForTimeout(350);
        }
      }
      const after=snapshot(root);const conversationAfter=profile==='small'?await fetch(server.url+'/api/coordinator').then(r=>r.json()):null;result.integrity.push({profile,device,edition,trial,before,after,conversationBefore,conversationAfter,unchanged:JSON.stringify(before)===JSON.stringify(after),note:profile==='small'?'four message receipts plus fake coordinator warm/completion writes expected; inspect task/log/placement stability and conversation turns':'navigation/read-mark writes outside selected domain tables are not compared'});save();
      await context.close();
      backendProbe?.close();backendProbe=undefined;await server.close();server=undefined;
      }
      removeWorkspace(root);root=undefined;
    }
  }
} catch(error){const failed=browser?.contexts().flatMap(c=>c.pages()).at(-1);if(failed){result.failurePage=await failed.evaluate(()=>({url:location.href,text:document.body.innerText,probe:{...(window as any).probe,animations:undefined}})).catch(()=>null);}result.failure=String((error as Error).stack);process.exitCode=1;}
finally{
  try{backendProbe?.close();await browser?.close();await server?.close();if(root&&existsSync(root))removeWorkspace(root);for(const originalRoot of originalRoots)removeWorkspace(originalRoot);if(paired){copyBuild(join(out,'restore-build'),release,true);rmSync(join(out,'restore-build'),{recursive:true});}}catch(e){result.cleanupFailure=String(e);process.exitCode=1;}
  clearTimeout(expiry);result.environment.loadAfter=loadavg();result.lifecycle.finishedAt=new Date().toISOString();save();
}
