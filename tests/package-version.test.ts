/** Every CLI displays the facts of its own distribution through this one Reader. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {readPackageVersion} from '@alpacawork/core/package-version';
test('local version facts preserve the public shape and reject mismatched SOURCE', t=>{
  const root=mkdtempSync(join(tmpdir(),'package-version-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const facts={source:'a'.repeat(40),format:'b'.repeat(64),schema:{control:16},skills:{sha256:'c'.repeat(64)}};
  writeFileSync(join(root,'package.json'),JSON.stringify({name:'fixture',version:'0.3.0',alpacawork:facts}));
  writeFileSync(join(root,'SOURCE'),facts.source+'\n');
  writeFileSync(join(root,'FORMAT'),facts.format+'\n');
  assert.deepEqual(readPackageVersion(root),{name:'fixture',version:'0.3.0',node:process.versions.node,...facts});
  writeFileSync(join(root,'SOURCE'),'d'.repeat(40));assert.throws(()=>readPackageVersion(root),/Package\/SOURCE mismatch/);
});
