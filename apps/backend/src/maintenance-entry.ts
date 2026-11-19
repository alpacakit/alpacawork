import { RECOVERY_PROTOCOL } from '@alpacawork/contract/recovery';
import { authorizeFailureRecovery, readFailureOperation } from './release/maintenance-authorization.js';
import { maintenance } from './maintenance.js';

  const [mode, root, ...extra] = process.argv.slice(2);
  if(mode==='recovery-protocol'&&!root) { process.stdout.write(String(RECOVERY_PROTOCOL)+'\n'); }
  else if(mode==='recovery-operation'&&root&&extra.length===2) {
    process.stdout.write(JSON.stringify(readFailureOperation(root,extra[0]!,extra[1]!,process.env))+'\n');
  }
  else if(mode==='recovery-authorize'&&root&&extra.length===1) {
    const env=process.env;
    authorizeFailureRecovery(root,extra[0]!,env.ALPACAWORK_RUN!==undefined||env.ALPACAWORK_RUN_TOKEN!==undefined
      ?{run:{runId:env.ALPACAWORK_RUN??'',token:env.ALPACAWORK_RUN_TOKEN??''}}:{});
    process.stdout.write('{}\n');
  }
  else {
  if (!root || !['inspect','migrate','compact','recovery-snapshot','recovery-files'].includes(mode!) ||
    (mode==='recovery-snapshot' ? extra.length<1 : extra.length!==0)) throw new Error('Expected inspect|migrate|compact <workspace> | recovery-snapshot <workspace> <directory> [declared-files]');
  const result=await maintenance(root, mode as 'inspect' | 'migrate' | 'compact' | 'recovery-snapshot' | 'recovery-files',extra[0],mode==='recovery-snapshot'?extra.slice(1):[]);
  process.stdout.write(JSON.stringify(mode==='recovery-snapshot'?{version:1,folder:extra[0]}:result) + '\n');
  }
