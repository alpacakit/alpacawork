import { readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const root=process.argv[2]!; const candidateLabel=process.argv[3]??'after-final'; const nativeLabel=process.argv[4]??'native';
const median=(xs:number[])=>[...xs].sort((a,b)=>a-b)[Math.floor(xs.length/2)]!;
const fixed=(n:number)=>Math.round(n*100)/100;
const aggregate=(rs:any[])=>{ assert.equal(rs.length,3,'each group must have three repetitions'); assert.ok(rs.every(r=>r.valid && Object.values(r.cdp).every(n=>Number.isFinite(n)) && Number.isFinite(r.frames.missed))); return ({n:rs.length,layouts:median(rs.map(r=>r.cdp.layouts)),layoutMs:fixed(median(rs.map(r=>r.cdp.layoutMs))),styleMs:fixed(median(rs.map(r=>r.cdp.styleMs))),scriptMs:fixed(median(rs.map(r=>r.cdp.scriptMs))),taskMs:fixed(median(rs.map(r=>r.cdp.taskMs))),missed:median(rs.map(r=>r.frames.missed)),commits:median(rs.map(r=>r.commits)),loaf:median(rs.map(r=>r.loaf.count))}); };
let browser:string|undefined; const all:any[]=[];for(const side of ['before','after'])for(const t of [1,4]){ const data=JSON.parse(readFileSync(root+'/'+(side==='after'?candidateLabel:'before-final')+'-t'+t+'.json','utf8')); assert.equal(data.throttle,t); browser??=data.browser; assert.equal(data.browser,browser); for(const r of data.results){assert.equal(r.throttle,t);all.push({...r,side,scenario:r.name.replace(/-\d+$/,'')});} }
const rows:any[]=[];for(const width of [1440,390])for(const t of [1,4])for(const scenario of [...new Set(all.filter(r=>r.width===width).map(r=>r.scenario))]){const result:any={width,throttle:t,scenario,sourceBefore:'before-final',sourceAfter:candidateLabel};for(const side of ['before','after'])result[side]=aggregate(all.filter(r=>r.width===width&&r.throttle===t&&r.scenario===scenario&&r.side===side));rows.push(result)}
for(const width of [1440,390])for(const t of [1,4]){
 const row:any={width,throttle:t,scenario:'new-mark',sourceBefore:'mark-before',sourceAfter:'mark-after'};
 for(const side of ['before','after']){
  const d=JSON.parse(readFileSync(`${root}/mark-${side}-t${t}.json`,'utf8'));
  assert.equal(d.browser,browser);assert.equal(d.throttle,t);assert.ok(d.results.every((r:any)=>r.throttle===t));
  const group=d.results.filter((r:any)=>r.width===width);
  assert.ok(group.every((r:any)=>r.markEvidence?.visible?.length===1 && r.markEvidence.visible[0] && r.markEvidence.samples.length===1 && r.markEvidence.samples[0].task===r.markEvidence.samples[0].expected));
  row[side]=aggregate(group);
 }
 rows.push(row);
}
writeFileSync(root+'/summary.json',JSON.stringify(rows,null,2));
const names:Record<string,string>={'new-mark':'新規印（毎回新Task）',update:'タイトル更新',arrive:'行追加',move:'行移動',zoom:'時間帯拡縮',edge:'端注記', 'bar-hide':'バー退き','bar-show':'バー戻り',pull:'引っぱって更新'};
let md='|幅|CPU|操作|layout回数 前→後|layout ms 前→後|style ms 前→後|script ms 前→後|rAF推定欠落frame 前→後|React commit 前→後|\n|---|---|---|---|---|---|---|---|---|\n';
for(const r of rows){const a=r.before,b=r.after;md+=`|${r.width}|${r.throttle}|${names[r.scenario]}|${a.layouts}→${b.layouts}|${a.layoutMs}→${b.layoutMs}|${a.styleMs}→${b.styleMs}|${a.scriptMs}→${b.scriptMs}|${a.missed}→${b.missed}|${a.commits}→${b.commits}|\n`}
writeFileSync(root+'/matrix.md',md);console.log(md);
try{const ns:any[]=[];for(const t of [1,4]){const data=JSON.parse(readFileSync(root+'/'+nativeLabel+'-t'+t+'.json','utf8'));assert.equal(data.browser,browser); assert.equal(data.throttle,t); assert.ok(data.results.every((r:any)=>r.throttle===t)); if(data.results.length!==24)throw new Error('native matrix incomplete '+data.results.length);ns.push(...data.results.map((r:any)=>({...r,scenario:r.name.replace(/-\d+$/,'')})))}
let native='|幅|CPU|操作|selectあり layout回/ms/rAF推定欠落frame|select除去 layout回/ms/rAF推定欠落frame|\n|---|---|---|---|---|\n';const result:any[]=[];for(const width of [1440,390])for(const t of [1,4])for(const scenario of width===1440?['artificial-head']:['bar-hide','bar-show','pull']){const row:any={width,throttle:t,scenario};for(const select of ['present','removed'])row[select]=aggregate(ns.filter(r=>r.width===width&&r.throttle===t&&r.scenario===scenario&&r.select===select));result.push(row);const a=row.present,b=row.removed;native+=`|${width}|${t}|${scenario==='artificial-head'?'見出し人工移動（実操作外）':names[scenario]}|${a.layouts} / ${a.layoutMs} / ${a.missed}|${b.layouts} / ${b.layoutMs} / ${b.missed}|\n`}
writeFileSync(root+'/native-summary.json',JSON.stringify(result,null,2));writeFileSync(root+'/native-matrix.md',native);console.log(native);
}catch(e){console.error('native invalid',String(e));throw e;}
