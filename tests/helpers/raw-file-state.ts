/** Physical evidence only. Never open SQLite while taking or validating these copies. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function rawFileState(root: string) {
  const rows: {path:string;kind:string;dev:string;ino:string;mode:number;uid:string;gid:string;links:string;size:string;sha256?:string;link?:string}[]=[];
  const visit=(path:string)=>{
    const file=join(root,path),stat=lstatSync(file,{bigint:true});
    const row={path,kind:stat.isDirectory()?'directory':stat.isFile()?'file':stat.isSymbolicLink()?'link':'other',
      dev:String(stat.dev),ino:String(stat.ino),mode:Number(stat.mode),uid:String(stat.uid),gid:String(stat.gid),links:String(stat.nlink),size:String(stat.size),
      ...(stat.isFile()?{sha256:createHash('sha256').update(readFileSync(file)).digest('hex')}:{ }),
      ...(stat.isSymbolicLink()?{link:readlinkSync(file)}:{ })};
    rows.push(row);
    if(stat.isDirectory())for(const name of readdirSync(file).sort())visit(path?path+'/'+name:name);
  };
  visit('');return rows;
}

export function copyRawFiles(source:string,destination:string) {
  assert(!existsSync(destination),'raw/copy destination must be new');
  const visit=(from:string,to:string)=>{
    const stat=lstatSync(from);
    if(stat.isDirectory()) {mkdirSync(to,{mode:0o700});for(const name of readdirSync(from))visit(join(from,name),join(to,name));}
    else if(stat.isFile())copyFileSync(from,to);
    else if(stat.isSymbolicLink())symlinkSync(readlinkSync(from),to);
    else throw Error('Unsupported raw artifact: '+from);
  };
  visit(source,destination);
}

export function captureRawFiles(source:string,destination:string) {
  const before=rawFileState(source);copyRawFiles(source,destination);
  const copied=new Map(rawFileState(destination).map(row=>[row.path,row]));
  for(const row of before) {
    const copy=copied.get(row.path);assert(copy,'raw entry copied: '+row.path);
    assert.equal(copy.kind,row.kind);assert.equal(copy.sha256,row.sha256);assert.equal(copy.link,row.link);
    if(row.kind==='file')assert.equal(copy.size,row.size);
  }
  assert.deepEqual(rawFileState(source),before,'source changed during raw capture');
  writeFileSync(destination+'.manifest.json',JSON.stringify({source,destination,capturedAt:new Date().toISOString(),entries:before},null,2));
  return before;
}
