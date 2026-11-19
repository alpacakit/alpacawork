import{test}from'node:test';import assert from'node:assert/strict';
import{mkdtempSync,realpathSync,rmSync,truncateSync,writeFileSync}from'node:fs';import{tmpdir}from'node:os';import{join}from'node:path';import{spawnSync}from'node:child_process';
import{fileHash}from'@alpacawork/db';
// A production control database passed 2 GiB and the stopped-server migration died in readFileSync before any receipt.
test('a control database larger than 2 GiB is hashed whole',{skip:process.platform!=='linux'&&'sha256sum reference'},t=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'alpacawork-file-hash-')));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const file=join(root,'alpacawork.sqlite');writeFileSync(file,'SQLite format 3\0');truncateSync(file,2**31+4097);
 const expected=spawnSync('sha256sum',[file],{encoding:'utf8'}).stdout.split(' ')[0];
 assert.match(expected,/^[0-9a-f]{64}$/);assert.equal(fileHash(file),expected);
});
