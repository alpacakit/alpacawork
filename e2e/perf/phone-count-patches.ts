/** Locate counter probes from production source maps; never use counted runs for latency. */
import {readFileSync,writeFileSync,readdirSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {TraceMap,originalPositionFor}=require(resolve('node_modules/.pnpm/node_modules/@jridgewell/trace-mapping'));
const [directory,out]=process.argv.slice(2);if(!directory||!out)throw Error('map assets directory and output required');
const targets=[['message-time.ts','messageTime'],['read-model.ts','subscribeReads'],['read-model.ts','foldReadFacts'],['shown.tsx','ShownConversationProvider'],['CoordinatorThread.tsx','CoordinatorThread'],['CoordinatorThread.tsx','MessageHead'],['CoordinatorThread.tsx','Message'],['SentMessage.tsx','SentTaskLabel']];
const found:any[]=[];
for(const file of readdirSync(directory).filter(s=>s.endsWith('.js'))){
 if(!existsSync(join(directory,file+'.map')))continue;
 const raw=JSON.parse(readFileSync(join(directory,file+'.map'),'utf8')),map=new TraceMap(raw),code=readFileSync(join(directory,file),'utf8');
 const lines=code.split('\n');let offset=0;
 for(let i=0;i<lines.length;i++){
  for(const match of lines[i]!.matchAll(/function(?:\s+([\w$]+))?\([^)]*\)\{/g)){
   const pos=originalPositionFor(map,{line:i+1,column:match.index+(match[1]?match[0].indexOf(match[1]):8)});
   for(const [source,name]of targets){
    if(!pos.source?.endsWith('/'+source))continue;
    const sourceIndex=raw.sources.indexOf(pos.source);const text=raw.sourcesContent[sourceIndex];if(!text)continue;
    const declaration=new RegExp('function '+name+'\\b').exec(text);if(!declaration)continue;
    const at=text.slice(0,declaration.index).split('\n').length;
    if(pos.line!==at)continue;
    found.push({asset:file,prefix:match[0],label:name,source:pos.source,line:pos.line,generated:i+1,column:match.index});
   }
  }offset+=lines[i]!.length+1;
 }
}
for(const [,name]of targets){const n=found.filter(p=>p.label===name).length;if(n!==1)throw Error('Expected one probe for '+name+': '+n);}
writeFileSync(out,JSON.stringify(found,null,2));console.log(found.map(p=>[p.label,p.asset,p.prefix,p.line]));
