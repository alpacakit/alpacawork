import { runUpdateController } from './update-controller.js';
import { resolveUpdateRuntime } from './update-runtime.js';
import { readInstallationService } from '../installation/setup.js';
import { loadJournal } from './journal.js';
import { continueStoppedSwitch, ServiceStartRequired } from './switch.js';
import { thisRelease } from './location.js';
const [mode,workspace,opId]=process.argv.slice(2);
if(!workspace||!opId||!['run','continue','setup'].includes(mode!))throw new Error('Expected update controller run|continue|setup workspace opId');
if(mode==='setup'){
  try{
    const selected=readInstallationService({workspace}), place={workspace,releases:selected.installation.releases,service:selected.definition.name,say:(line:string)=>console.error(line)};
    const journal=loadJournal(place);
    if(!journal||journal.opId!==opId||journal.target!==thisRelease())throw new Error('Setup continuation target differs');
    const ready=await continueStoppedSwitch(place,journal);
    process.stdout.write(JSON.stringify({ready})+'\n');
  }catch(error){process.stdout.write(JSON.stringify({error:{message:error instanceof Error?error.message:String(error),...(error instanceof ServiceStartRequired?{service:error.service}:{})}})+'\n');}
}else{
  const ready=await runUpdateController(resolveUpdateRuntime(workspace),opId,mode as 'run'|'continue');
  process.stdout.write(JSON.stringify(ready)+'\n');
}
