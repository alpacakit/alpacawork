/** A bounded provider subject. Markers record the actual process and processing of each input ID. */
import { createInterface } from 'node:readline';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
const args=process.argv.slice(2), arg=name=>args[args.indexOf(name)+1];
const bridge = args.includes('--bridge');
const root=arg('--root'), session=arg('--session'), run=process.env.ALPACAWORK_RUN;
if(!root||!session||!run)throw Error('Subject identity missing');
const folder=join(root,'subjects');mkdirSync(folder,{recursive:true,mode:0o700});
const marker=join(folder,`${run}-${process.pid}.json`), gate=join(root,`gate-${run}`), inputs=[];
const save=()=>writeFileSync(marker,JSON.stringify({run,pid:process.pid,session,inputs,at:new Date().toISOString()}));
const emit=value=>process.stdout.write(JSON.stringify(value)+'\n');
save();emit(bridge ? {type:'thread.started',thread_id:session} : {type:'system',subtype:'init',session_id:session});
let open=!args.includes('--plain');
if(open){
  const lines=createInterface({input:process.stdin});lines.on('close',()=>{open=false});
  lines.on('line',line=>{
    const input=JSON.parse(line), text=input.message?.content??input.text, id=input.uuid??input.id;
    if(typeof id!=='string'||typeof text!=='string')throw Error('Invalid stream-json input');
    if(text.includes('CERTIFIED_NOT_SENT')){emit({type:'input.not_sent',evidence:'transfer_not_started',id});return;}
    inputs.push({id,text,processedAt:new Date().toISOString()});save();
    if(text.includes('LEGACY_REFUSAL')){emit({type:'input.refused',id});return;}
    if(text.includes('NO_RECEIPT'))return;
    if(text.includes('LATE_TAKEN')){
      emit({type:'input.uncertain',id});
      void(async()=>{for(let i=0;i<600&&!existsSync(join(root,'late-'+id));i++)await delay(50);
        emit(bridge ? {type:'input.taken',id} : {type:'command_lifecycle',state:'started',command_uuid:id});})();return;
    }
    emit(bridge ? {type:'input.taken',id} : {type:'command_lifecycle',state:'started',command_uuid:id});
  });
}
for(let i=0;i<1200&&!existsSync(gate);i++)await delay(50);
if(!existsSync(gate))throw Error('Subject deadline expired');
if (bridge) { writeFileSync(arg('--result'), `RESULT:${run}:${process.pid}`); emit({type:'turn.completed'}); }
else emit({type:'result',session_id:session,is_error:false,result:`RESULT:${run}:${process.pid}`,modelUsage:{test:{inputTokens:11,cacheReadInputTokens:3,cacheCreationInputTokens:2,outputTokens:7}}});
await new Promise(done=>process.stdout.write('',done));
process.exit(0);
