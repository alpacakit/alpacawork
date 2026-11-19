/** Fixed control specification kept as a test fixture; its list classification is not the current one. */
export const BASES = ['todo','doing','error','waiting','done','stopped'];
export const DIRECTIONS = ['parent_operation','child_change','structure_insert'];
const terminal = state => ['done','stopped'].includes(state);
const R=(id,priority,when,out)=>({id,priority,when,out});
const change=(code,fields={})=>({kind:'cochange',code,...fields});
const reject=code=>({kind:'reject',code});
const keep=(code,fields={})=>({kind:'keep',code,...fields});
export const TASK_POLICY = {
 composition: { cumulativeFaces: ['finish'] },
 parentChild:[
  R('P00',0,f=>f.parentBase==='stopped'&&!terminal(f.childBase)&&f.direction==='child_change'&&!f.resumeAuthorized,reject('stopped_scope_not_authorized')),
  R('P01',1,f=>terminal(f.parentBase)&&!terminal(f.childBase)&&f.direction!=='child_change',reject('unfinished_under_terminal')),
  R('P02',2,f=>terminal(f.parentBase)&&!terminal(f.childBase)&&f.direction==='child_change',change('reopen_terminal',{parentBase:'doing',preserveHold:true,continuation:true})),
  R('P03',3,f=>f.parentBase==='waiting'&&f.direction==='parent_operation'&&!terminal(f.childBase),reject('review_with_unfinished_child')),
  R('P04',4,f=>f.parentBase==='waiting'&&f.direction!=='parent_operation',change('invalidate_review',{parentBase:'doing',preserveHold:true,continuation:true})),
  R('P05',5,()=>true,keep('pair_valid')),
 ],
 hold:[
  R('H01',1,f=>(['hold','unhold','resume'].includes(f.action)||f.hold&&['confirm','stop'].includes(f.action))&&!f.explicit,reject('explicit_user_decision_required')),
  R('H02',2,f=>f.action==='hold',change('hold',{hold:true})),
  R('H03',3,f=>f.action==='unhold',change('unhold',{hold:false})),
  R('H04',4,f=>['resume','confirm','stop'].includes(f.action),change('explicit_release',{hold:false})),
  R('H05',5,()=>true,keep('preserve_hold')),
 ],
 finish:[
  R('F01',1,f=>f.unknown!==false||[f.questions,f.requests,f.undelivered,f.unfinishedBelow,f.otherRuns].some(n=>!Number.isSafeInteger(n)||n<0)||f.needsReview&&(typeof f.reviewFresh!=='boolean'||typeof f.reviewRunEnded!=='boolean'),reject('finish_facts_unknown')),
  R('F02',2,f=>f.questions>0,reject('open_question')),
  R('F03',3,f=>f.requests>0,reject('open_request')),
  R('F04',4,f=>f.undelivered>0,reject('undelivered_result')),
  R('F05',5,f=>f.unfinishedBelow>0,reject('unfinished_below')),
  R('F06',6,f=>f.otherRuns>0,reject('other_run_unfinished')),
  R('F07',7,f=>f.needsReview&&(!f.reviewFresh||!f.reviewRunEnded),reject('review_not_ready')),
  R('F08',8,()=>true,keep('finish_clear')),
 ],
 wake:{selection:{open:{none:[],closing:[],notice:['notice'],mixed:['notice']},closed:{none:[],closing:['closing'],notice:['notice'],mixed:['closing','notice']}},
  gates:[
   R('W01',1,f=>!f.active||terminal(f.baseState),keep('finished')),
   R('W02',2,f=>f.hold,keep('held')),
   R('W03',3,f=>f.failed&&(f.outcome==='work_changed'||!f.serverRequest),keep('failure')),
   R('W04',4,f=>f.hasRows&&!f.profile,keep('gate')),
   R('W05',5,f=>f.hasRows&&f.limit,keep('gate')),
   R('W06',6,f=>f.uncertain,keep('gate')),
   R('W07',7,f=>f.hasRows&&f.refused,keep('gate')),
   R('W08',8,f=>f.needsReview,keep('run_review')),
   R('W09',9,f=>f.busy,keep('active')),
   R('W10',10,f=>!f.hasRows,keep('nothing_deliverable')),
   R('W11',11,()=>true,keep('deliver')),
  ]},
};
export function rowsOf(face,policy=TASK_POLICY){return face==='wakeGate'?policy.wake.gates:policy[face]}
export function evaluateFace(face,facts,policy=TASK_POLICY){
 const rows=[...rowsOf(face,policy)].sort((a,b)=>a.priority-b.priority);
 const matching=policy.composition.cumulativeFaces.includes(face)?rows.filter(r=>r.when(facts)):[];
 if(!policy.composition.cumulativeFaces.includes(face)){const first=rows.find(r=>r.when(facts));if(first)matching.push(first);}
 if(!matching.length)throw Error('Unlisted '+face+' '+JSON.stringify(facts));
 const first=matching[0],selected=policy.composition.cumulativeFaces.includes(face)?matching:[first],materialize=out=>Object.fromEntries(Object.entries(out).map(([k,v])=>[k,typeof v==='function'?v(facts):v]));
 return {rule:first.id,...materialize(first.out),all:selected.filter(r=>!['delegate','pair_valid','base_unchanged','preserve_hold'].includes(r.out.code)).map(r=>({rule:r.id,priority:r.priority,...materialize(r.out)})).filter(r=>r.code!=='none')};
}
export function parentChild(facts,policy=TASK_POLICY){
 if(!BASES.includes(facts.parentBase)||!BASES.includes(facts.childBase)||!DIRECTIONS.includes(facts.direction))throw Error('Unknown pair axis');
 return evaluateFace('parentChild',facts,policy);
}
