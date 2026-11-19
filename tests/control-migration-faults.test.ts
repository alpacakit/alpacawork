import{test}from'node:test';import assert from'node:assert/strict';
import{mkdtempSync,readFileSync,realpathSync,rmSync}from'node:fs';import{tmpdir}from'node:os';import{join}from'node:path';import{spawnSync}from'node:child_process';
import{ControlStore,holdControlWriter}from'@alpacawork/db';import{cleanCliEnv}from'./helpers/http-cli.ts';
// Storage deliberately rejects linked ancestors; macOS's tmpdir includes /var -> /private/var.
function rootFor(t:any){const root=realpathSync(mkdtempSync(join(tmpdir(),'alpacawork-migration-')));t.after(()=>rmSync(root,{recursive:true,force:true}));new ControlStore(root,{busyTimeoutMs:1000},false,true).close();return root}
test('a competing serve writer is refused before its actual SQLite open',{skip:process.platform!=='linux'&&'Linux syscall observation'},t=>{
 const root=rootFor(t),release=holdControlWriter(root),trace=join(root,'second-writer.trace');try{const child=spawnSync('strace',['-f','-e','trace=openat,openat2','-o',trace,process.execPath,'--input-type=module','-e',"import{ControlStore}from'@alpacawork/db';new ControlStore(process.argv[1]).close()",root],{env:cleanCliEnv(),encoding:'utf8',timeout:15000});assert.notEqual(child.status,0);assert.match(child.stderr,/Another serve writer/);assert.equal(readFileSync(trace,'utf8').includes('alpacawork.sqlite'),false)}finally{release()}
});
