/** Attribute a separate phone-survey CPU/trace capture to byte-matched production source maps. */
import {readFileSync,writeFileSync,readdirSync,existsSync} from 'node:fs';
import {resolve,basename,join} from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {TraceMap,originalPositionFor}=require(resolve('node_modules/.pnpm/node_modules/@jridgewell/trace-mapping'));
const [maps, ...directories]=process.argv.slice(2);
if(!maps||!directories.length)throw Error('maps-build/assets and capture directories required');
const cache=new Map();
function mapped(frame){
 const file=basename(frame.url||'');const mapPath=join(maps,file+'.map');
 if(!existsSync(mapPath)||frame.lineNumber<0)return {function:frame.functionName||'(anonymous)',url:frame.url,line:frame.lineNumber+1,column:frame.columnNumber};
 if(!cache.has(file))cache.set(file,new TraceMap(JSON.parse(readFileSync(mapPath,'utf8'))));
 const pos=originalPositionFor(cache.get(file),{line:frame.lineNumber+1,column:frame.columnNumber});
 return {function:pos.name||frame.functionName||'(anonymous)',source:pos.source,line:pos.line,column:pos.column,generated:{asset:file,function:frame.functionName,line:frame.lineNumber+1,column:frame.columnNumber}};
}
const all=[];
for(const dir of directories){
 const meta=JSON.parse(readFileSync(join(dir,'results.json'),'utf8'));
 for(const file of readdirSync(dir).filter(f=>f.endsWith('.cpuprofile'))){
  const profile=JSON.parse(readFileSync(join(dir,file),'utf8'));const name=file.replace('.cpuprofile','');const result=meta.results.find(r=>r.name===name);
  const nodes=new Map(profile.nodes.map(n=>[n.id,n]));const parents=new Map();for(const n of profile.nodes)for(const child of n.children||[])parents.set(child,n.id);
  const start=result?.metricsWindow?.before.NavigationStart*1e6+result?.startMs*1000;
  const end=result?.metricsWindow?.before.NavigationStart*1e6+result?.endProbe.observedNow*1000;
  let at=profile.startTime,total=0;const self=new Map(),inclusive=new Map();
  for(let n=0;n<profile.samples.length;n++){
   const dt=profile.timeDeltas[n];at+=dt;if(Number.isFinite(start)&&(at<start||at>end))continue;
   total+=dt;const id=profile.samples[n];self.set(id,(self.get(id)||0)+dt);
   let parent=id;const seen=new Set();while(parent&&!seen.has(parent)){seen.add(parent);inclusive.set(parent,(inclusive.get(parent)||0)+dt);parent=parents.get(parent);}
  }
  const aggregateSelf=new Map();for(const [id,micros]of self){const frame=mapped(nodes.get(id).callFrame);const key=JSON.stringify(frame);const prior=aggregateSelf.get(key)||{ms:0,...frame};prior.ms+=micros/1000;aggregateSelf.set(key,prior);}const groupedSelf=[...aggregateSelf.values()].sort((a,b)=>b.ms-a.ms);
  const nativeStacks=[...self].filter(([id])=>['getBoundingClientRect','getPropertyValue','removeChild'].includes(nodes.get(id).callFrame.functionName)).sort((a,b)=>b[1]-a[1]).slice(0,12).map(([id,ms])=>{let current=id;const stack=[];for(let i=0;i<20&&current;i++){stack.push(mapped(nodes.get(current).callFrame));current=parents.get(current);}return{ms:ms/1000,stack};});
  const rank=times=>[...times].sort((a,b)=>b[1]-a[1]).slice(0,40).map(([id,micros])=>({id,ms:micros/1000,...mapped(nodes.get(id).callFrame)}));
  const tracePath=join(dir,name+'.trace.json');let traceSummary;
  if(existsSync(tracePath)){
   const traceEvents=JSON.parse(readFileSync(tracePath,'utf8')).traceEvents;const threads=traceEvents.filter(e=>e.name==='thread_name'&&e.args?.name==='CrRendererMain');
   const events=traceEvents.filter(e=>threads.some(t=>t.pid===e.pid&&t.tid===e.tid)).filter(e=>e.ph==='X'&&e.dur&&(!Number.isFinite(start)||e.ts+e.dur>=start&&e.ts<=end));
   const stats=new Map();for(const e of events){const q=stats.get(e.name)||{ms:0,count:0,maxMs:0};q.ms+=e.dur/1000;q.count++;q.maxMs=Math.max(q.maxMs,e.dur/1000);stats.set(e.name,q);}
   traceSummary=[...stats].sort((a,b)=>b[1].ms-a[1].ms).slice(0,45).map(([name,v])=>({name,...v}));
  }
  const output={name,directory:dir,window:{start,end,profileStart:profile.startTime,profileEnd:profile.endTime},sampledMs:total/1000,elapsedMs:result?.elapsedMs,scriptMs:result?.scriptMs,styleMs:result?.styleMs,layoutMs:result?.layoutMs,frameMaxMs:result?.frameMaxMs,nativeStacks,groupedSelf,self:rank(self),inclusive:rank(inclusive),traceSummary};
  writeFileSync(join(dir,name+'.analysis.json'),JSON.stringify(output,null,2));all.push(output);
 }
}
writeFileSync(resolve(directories[0],'../profile-summary.json'),JSON.stringify(all,null,2));
for(const p of all){console.log(p.name,Math.round(p.elapsedMs)+'ms, sampled '+Math.round(p.sampledMs)+'ms');console.log(p.self.slice(0,9).map(x=>`${Math.round(x.ms)}ms ${x.function} ${x.source||x.url}:${x.line}`).join('\n'));}
