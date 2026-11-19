import { writeFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
const [root, mode='hold'] = process.argv.slice(2);
const deadline = Date.now()+20000;
// Existence is the readiness signal: publish it only once all JSON bytes are written.
const receipt = join(root, mode+'-pid.json'), temporary = receipt+'.tmp';
writeFileSync(temporary, JSON.stringify({pid:process.pid,deadline}));
renameSync(temporary, receipt);
if(mode==='leader') {
  const child=spawn(process.execPath,[import.meta.filename,root,'descendant'],{stdio:'ignore'});child.unref();
  while(!existsSync(join(root,'leader-exit'))&&Date.now()<deadline) await delay(10);
  process.exit(0);
}
setTimeout(()=>process.exit(0),Math.max(1,deadline-Date.now()));
