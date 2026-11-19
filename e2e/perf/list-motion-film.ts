/** Pair the compositor frames at their original timestamps; hold missing frames, never interpolate motion. */
import { readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const [before,after,out]=process.argv.slice(2);mkdirSync(out!,{recursive:true});
const titles:Record<string,string>={update:'行の更新',arrive:'行の追加',move:'行の移動と新しい印',zoom:'時間帯の拡縮',edge:'端の注記', 'bar-hide':'バーが退く','bar-show':'バーが戻る',pull:'引っぱって更新'};
const ff=(args:string[])=>{const r=spawnSync('ffmpeg',['-y','-loglevel','error','-filter_complex_threads','2',...args],{encoding:'utf8',timeout:120_000});if(r.error || r.status !== 0)throw new Error(String(r.error ?? r.stderr))};
for(const width of [1440,390]){
 const clips:string[]=[];const scenes=width===390?['update','arrive','move','zoom','edge','bar-hide','bar-show','pull']:['update','arrive','move','zoom','edge'];
 for(const scene of scenes){const seq=(root:string)=>readdirSync(root+'/'+width+'-'+scene+'-0').filter(n=>n.endsWith('.jpg')).sort().map(n=>({ms:Number(n.slice(0,5)),file:resolve(root+'/'+width+'-'+scene+'-0/'+n)}));const b=seq(before!),a=seq(after!);const end=Math.max(b.at(-1)!.ms,a.at(-1)!.ms)+700;
 const lists=[b,a].map((seq,index)=>{const file=out+'/'+width+'-'+scene+'-'+index+'.concat';let text=`file '${seq[0]!.file}'\noption framerate 1000\nduration 1.2\n`;if(seq[0]!.ms>0)text+=`file '${seq[0]!.file}'\noption framerate 1000\nduration ${seq[0]!.ms/1000}\n`;for(let i=0;i<seq.length;i++)text+=`file '${seq[i]!.file}'\noption framerate 1000\nduration ${((seq[i+1]?.ms??end)-seq[i]!.ms)/1000}\n`;text+=`file '${seq.at(-1)!.file}'\noption framerate 1000\n`;writeFileSync(file,text);return file});
 const clip=out+'/'+width+'-'+scene+'.mp4';const crop='';
 const font='/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc';
 const label=(side:string,colour:string)=>`drawtext=fontfile=${font}:text='${side}  ${titles[scene]}':x=12:y=12:fontsize=${width===1440?32:20}:fontcolor=${colour},drawtext=fontfile=${font}:text='対象を確認（静止）':enable='lt(t,1.2)':x=12:y=50:fontsize=${width===1440?22:14}:fontcolor=white,drawtext=fontfile=${font}:text='実時間の動き':enable='gte(t,1.2)':x=12:y=50:fontsize=${width===1440?22:14}:fontcolor=white`;
 const combine=width===1440?'[b][a]vstack=inputs=2,scale=800:-2':'[b][a]hstack=inputs=2';
 const filter=`[0:v]${crop}pad=iw:ih+80:0:80:color=0x202020,${label('前','0xffc878')}[b];[1:v]${crop}pad=iw:ih+80:0:80:color=0x202020,${label('後','0x8ce68c')}[a];${combine},fps=60,format=yuv420p[v]`;
 ff(['-safe','0','-f','concat','-i',lists[0]!,'-safe','0','-f','concat','-i',lists[1]!,'-filter_complex',filter,'-map','[v]','-t',String(end/1000+1.2),'-c:v','libx264','-threads','2','-crf','20','-preset','fast',clip]);clips.push(resolve(clip));
 }
 const join=out+'/'+width+'-clips.concat';writeFileSync(join,clips.map(p=>`file '${p}'`).join('\n'));ff(['-safe','0','-f','concat','-i',join,'-c','copy',out+'/compare-'+width+'.mp4']);console.log(out+'/compare-'+width+'.mp4');
}
