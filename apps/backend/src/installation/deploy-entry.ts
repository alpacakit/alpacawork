import { codecs, defineEntry, defineEntryEndpoint, defineEntryNode, defineParameter, optional, required } from '@alpacakit/channels';
import { bindCliEntry, CLI_ARG_KIND } from '@alpacakit/channels/cli';
import { Problem, PROBLEM_CODE } from '@alpacawork/core';
import { requireLocal, requireRoot, type Context } from '../entries.js';
import { runDeploy } from './deploy.js';
const option=(name:string,description:string)=>defineParameter({name,description,codec:codecs.string(),requirement:optional()});
const entry=defineEntry({name:'deploy',parameters:[
  defineParameter({name:'source',description:'Repository path[#branch-or-commit], or npm:<name>[@version]',codec:codecs.string(),requirement:required()}),
  option('releases','Release directory (default: recorded installation)'),option('service','User service name (default: recorded installation)'),
  option('server','Connected local server used when no installation record exists'),
  option('confirm','Confirmation value printed by the same deployment plan; required without a terminal for updates'),
  option('kind','Edition: production (default) or diagnostic'),
  option('port','Loopback port of a first installation, 1..65535 (change later with alpacawork setup)'),option('public-host','Public host[:port] of a first installation behind a reverse proxy (change later with alpacawork setup)'),
],project:({values})=>values});
export const deployNode=defineEntryNode({name:'deploy',description:'Install or update from committed repository input or npm. Examples: deploy .; deploy .#origin/main; deploy npm:alpacawork@0.1.0',
  endpoints:[defineEntryEndpoint(entry,{channels:[bindCliEntry({parameters:entry.parameters.map(p=>({kind:p.name==='source'?CLI_ARG_KIND.positional:CLI_ARG_KIND.option,parameterName:p.name}))})],
    handler:(values:Record<string,string|undefined>,context:Context)=>{
      if(!context.cli)throw new Error('Deploy requires the local CLI');
      if(values.kind!==undefined&&!['production','diagnostic'].includes(values.kind))throw new Problem(PROBLEM_CODE.invalidInput,'--kind must be production or diagnostic');
      requireLocal(context,{name:'release'},()=>requireRoot(context));
      return runDeploy({...context.cli,explicit:context.root,source:values.source!,releases:values.releases,service:values.service,server:values.server,
        confirm:values.confirm,kind:values.kind as 'production'|'diagnostic'|undefined,port:values.port===undefined?undefined:Number(values.port),publicHost:values['public-host']},line=>console.error(`deploy: ${line}`));
    }})]});
