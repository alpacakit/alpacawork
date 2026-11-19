/** Pair the actual compositor frames at their timestamps. Never interpolate movement. */
import {readFileSync,readdirSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
const [before,after,out]=process.argv.slice(2) as [string,string,string];mkdirSync(out,{recursive:true});
const sources=[before,after].map((root,i)=>{
 const info=JSON.parse(readFileSync(root,'utf8'));const flow=info.flows[0],offset=flow.filmOffsetMs;
 const dir=root+'.film/390-pull-0';const frames=readdirSync(dir).filter(n=>n.endsWith('.jpg')).sort().map(n=>({at:Number(n.slice(0,5))-offset,path:resolve(dir,n)}));
 const timeline=[{...frames.filter(f=>f.at<=0).at(-1)??frames[0]!,at:0},...frames.filter(f=>f.at>0)];
 const end=info.results.at(-1).startMs+info.results.at(-1).durationMs+500;
 let text=`file '${timeline[0]!.path}'\noption framerate 1000\nduration 1.2\n`;
 for(let j=0;j<timeline.length;j++)text+=`file '${timeline[j]!.path}'\noption framerate 1000\nduration ${Math.max(1,(timeline[j+1]?.at??end)-timeline[j]!.at)/1000}\n`;
 text+=`file '${timeline.at(-1)!.path}'\noption framerate 1000\n`;const file=out+'/'+i+'.concat';writeFileSync(file,text);return{file,end,info};
});
const font='/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc';
const labels=sources.map(({info},i)=>{
 const phases=info.results.map((r:any)=>({start:1.2+r.startMs/1000,end:1.2+(r.startMs+r.durationMs)/1000,name:r.name.split('-')[0]}));
 const names:Record<string,string>={drag:'下に引っ張る',release:'離す・保持へ',loading:'読み込み・一覧更新',return:'完了印・一覧が戻る'};
 let f=`[${i}:v]pad=iw:ih+90:0:90:color=0x202020,drawtext=fontfile=${font}:text='${i?'後':'前'}  引っ張って更新':x=10:y=10:fontsize=20:fontcolor=white,drawtext=fontfile=${font}:text='回転と一覧の戻りを見る':x=10:y=38:fontsize=16:fontcolor=white,drawtext=fontfile=${font}:text='冒頭は静止・以降は実時間':enable='lt(t,1.2)':x=10:y=63:fontsize=14:fontcolor=white`;
 for(const p of phases)f+=`,drawtext=fontfile=${font}:text='${names[p.name]}':enable='between(t,${p.start},${p.end})':x=10:y=63:fontsize=16:fontcolor=yellow`;
 const drag=phases[0]!;f+=`,drawbox=x=170:y=150:w=50:h=140:color=red:t=2,drawbox=x=188:y='390+300*min(max((t-${drag.start})/${drag.end-drag.start},0),1)':w=14:h=14:color=yellow:t=3:enable='between(t,${drag.start},${drag.end})'[v${i}]`;return f;
}).join(';');
const result=spawnSync('ffmpeg',['-y','-loglevel','error','-filter_complex_threads','2','-safe','0','-f','concat','-i',sources[0]!.file,'-safe','0','-f','concat','-i',sources[1]!.file,'-filter_complex',labels+';[v0][v1]hstack=inputs=2,fps=60,format=yuv420p[v]','-map','[v]','-t',String(Math.max(...sources.map(s=>s.end))/1000+1.2),'-c:v','libx264','-threads','2','-crf','20','-preset','fast',out+'/compare.mp4'],{encoding:'utf8',timeout:120000});
if(result.status!==0)throw new Error(result.stderr);console.log(out+'/compare.mp4');
