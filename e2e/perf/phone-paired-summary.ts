/** Same-operation before/after comparison. Raw windows, outliers and paired deltas are retained. */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
const root = resolve(process.argv[2]!);
const median = (values: number[]) => { const sorted=[...values].sort((a,b)=>a-b),at=sorted.length>>1;return sorted.length%2?sorted[at]!: (sorted[at-1]!+sorted[at]!)/2; };
const stat = (values: number[]) => values.length ? { median:median(values), min:Math.min(...values),max:Math.max(...values) } : null;
const rows: any[] = [];
for (const mode of ['catalog','chat','detail']) {
 const at = join(root, 'paired-'+mode);
 const before=JSON.parse(readFileSync(join(at,'before/results.json'),'utf8'));
 const after=JSON.parse(readFileSync(join(at,'after/results.json'),'utf8'));
 const pairs=JSON.parse(readFileSync(join(at,'pairs.json'),'utf8'));
 if(before.width!==390||after.width!==390||before.height!==900||after.height!==900||before.throttle!==4||after.throttle!==4||before.browser!==after.browser||before.fixture.key!==after.fixture.key) throw Error('Unmatched conditions');
 const operations = [...new Set<string>(before.results.filter((r:any)=>!r.name.startsWith('warm-')).map((r:any)=>r.name.replace(/-\d+$/,'')))];
 for(const name of operations) {
  const first=before.results.filter((r:any)=>r.name.replace(/-\d+$/,'')===name),last=after.results.filter((r:any)=>r.name.replace(/-\d+$/,'')===name);
  if(first.length<6||first.length!==last.length)throw Error('Insufficient repeats: '+name);
  const summarize=(values:any[])=>Object.fromEntries(['elapsedMs','frameMaxMs','releaseToEndMs','semanticMs','scriptMs','layoutMs','styleMs','blockingMs','rowReads','commits'].map(key=>[key,stat(values.map(r=>r[key]).filter(n=>typeof n==='number'))]));
  const paired=first.map((r:any)=>{const other=last.find((a:any)=>a.name===r.name);if(!other||!pairs.some((p:any)=>p.name===r.name))throw Error('Missing pair');return{name:r.name,deltaMs:other.elapsedMs-r.elapsedMs,before:r,after:other};});
  rows.push({mode,operation:name,n:first.length,before:summarize(first),after:summarize(last),pairedDeltaMs:stat(paired.map((r:any)=>r.deltaMs)),pairs:paired});
 }
}
rows.sort((a,b)=>b.before.elapsedMs.median-a.before.elapsedMs.median);
writeFileSync(join(root,'comparison.json'),JSON.stringify({capturedAt:new Date().toISOString(),width:390,height:900,throttle:4,ordering:'each pair alternates first side by round parity; all outliers retained',rows},null,2));
const span=(s:any)=>s?`${s.median.toFixed(0)} [${s.min.toFixed(0)}–${s.max.toFixed(0)}]`:'—';
const md=['|操作|n|before ms 中央値[範囲]|after ms 中央値[範囲]|paired差 中央値 ms|最大RAF 中央値/最悪 before→after|離して後 中央値 before→after|','|---|---:|---:|---:|---:|---:|---:|'];
for(const r of rows)md.push(`|${r.operation}|${r.n}|${span(r.before.elapsedMs)}|${span(r.after.elapsedMs)}|${span(r.pairedDeltaMs)}|${r.before.frameMaxMs.median.toFixed(0)}/${r.before.frameMaxMs.max.toFixed(0)} → ${r.after.frameMaxMs.median.toFixed(0)}/${r.after.frameMaxMs.max.toFixed(0)}|${span(r.before.releaseToEndMs)} → ${span(r.after.releaseToEndMs)}|`);
writeFileSync(join(root,'comparison.md'),md.join('\n')+'\n');console.log(md.join('\n'));
