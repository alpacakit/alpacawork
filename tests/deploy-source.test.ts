import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDeploySource, pinDeployRepository, commitPackage } from '../apps/backend/test-dist/release/deploy-source.js';
import { deployConfirmation, assertDeployConfirmation } from '../apps/backend/test-dist/installation/deploy.js';
import { candidateEnvironment } from '../apps/backend/test-dist/release/update-runtime.js';

test('one source argument separates repository refs from literal npm versions and rejects URLs and missing npm prefix', () => {
  assert.deepEqual(parseDeploySource('.', '/work', '/home/test'), {kind:'repository',repo:'/work',ref:'HEAD'});
  assert.deepEqual(parseDeploySource('~/repo#origin/feature/x','/work','/home/test'),{kind:'repository',repo:'/home/test/repo',ref:'origin/feature/x'});
  assert.deepEqual(parseDeploySource('npm:@scope/app@1.2.3','/work','/home/test'),{kind:'npm',packageName:'@scope/app',selector:'1.2.3'});
  assert.deepEqual(parseDeploySource('npm:alpacawork','/work','/home/test'),{kind:'npm',packageName:'alpacawork',selector:'latest'});
  for(const bad of ['https://example.test/repo','git@example.test:repo','./build.tgz','app@1.2.3','.#','.#-flag','.#main#other','npm:app@^1.0.0'])
    assert.throws(()=>parseDeploySource(bad,'/work','/home/test'));
  const plan={workspace:'/a',current:'before',target:'after',service:'a.service',skills:['alpacawork']};
  assert.doesNotThrow(()=>assertDeployConfirmation(plan,deployConfirmation(plan)));
  for(const changed of [{workspace:'/b'},{current:'another'},{target:'different'},{service:'b.service'},{skills:[]}])
    assert.throws(()=>assertDeployConfirmation({...plan,...changed},deployConfirmation(plan)),/plan changed/);
  const arch=Object.getOwnPropertyDescriptor(process,'arch')!;
  try {
    Object.defineProperty(process,'arch',{...arch,value:'unsupported'});
    assert.throws(()=>candidateEnvironment('production'),{
      code:'unsupported_platform',message:'This installation has no supported release target',
      reason:{kind:'installation_release_target_unsupported'},
    });
  } finally { Object.defineProperty(process,'arch',arch); }
});

test('repository input pins committed bytes and fetches a registered remote branch without checkout or tracking-ref changes', t => {
  const root=mkdtempSync(join(tmpdir(),'deploy-source-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const upstream=join(root,'upstream'),repo=join(root,'repo');mkdirSync(upstream);
  const git=(cwd:string,...args:string[])=>execFileSync('git',['-C',cwd,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  git(upstream,'init','-b','main');git(upstream,'config','user.name','Synthetic');git(upstream,'config','user.email','synthetic@example.test');
  writeFileSync(join(upstream,'package.json'),JSON.stringify({name:'synthetic',version:'1.0.0'}));git(upstream,'add','.');git(upstream,'commit','-m','one');
  const old=git(upstream,'rev-parse','HEAD');git(root,'clone',upstream,repo);
  writeFileSync(join(upstream,'package.json'),JSON.stringify({name:'synthetic',version:'2.0.0'}));git(upstream,'add','.');git(upstream,'commit','-m','two');
  const next=git(upstream,'rev-parse','HEAD');writeFileSync(join(repo,'package.json'),'uncommitted bytes');
  assert.equal(pinDeployRepository({kind:'repository',repo,ref:'HEAD'}).sha,old);
  const pinned=pinDeployRepository({kind:'repository',repo,ref:'origin/main'});assert.equal(pinned.sha,next);
  assert.equal(commitPackage(repo,pinned.sha).version,'2.0.0');
  assert.equal(git(repo,'rev-parse','HEAD'),old);assert.equal(git(repo,'rev-parse','refs/remotes/origin/main'),old);
  assert.equal(git(repo,'for-each-ref','refs/alpacawork/deploy'), '');
});
