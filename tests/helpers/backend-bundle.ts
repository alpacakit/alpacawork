/** Locate emitted code for bounded fixture instrumentation, without an import graph or a parallel build. */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
export function backendBundleWith(root: string, marker: string): string {
  const directory=join(root,'apps/backend/dist');
  const matches=readdirSync(directory,{recursive:true,encoding:'utf8'}).filter(name=>name.endsWith('.js'))
    .map(name=>join(directory,name)).filter(file=>readFileSync(file,'utf8').includes(marker));
  assert.equal(matches.length,1,`Expected one emitted backend module containing ${marker}`);
  return matches[0]!;
}
export function fixtureUpdateRuntime(root:string,body:string):void {
 const file=backendBundleWith(root,'function updateRuntime('),source=readFileSync(file,'utf8');
 writeFileSync(file,source.replace('function updateRuntime(','function fixtureRuntimeOwner(')+'\nfunction updateRuntime(workspace,env=process.env){'+body+'}\n');
}
export function prependBackendInstrumentation(file:string,code:string):void {
 const source=readFileSync(file,'utf8'),line=source.startsWith('#!')?source.indexOf('\n')+1:0;
 writeFileSync(file,source.slice(0,line)+code+'\n'+source.slice(line));
}

/** Expose the bundled platform only in a private, pre-seal fixture image. */
export function fixturePlatformEntry(root:string):string {
 const file=backendBundleWith(root,'platform = selectHost()'),source=readFileSync(file,'utf8');
 if(!source.includes('export { platform as __fixturePlatform };'))writeFileSync(file,source+'\nexport { platform as __fixturePlatform };\n');
 const entry=join(root,'apps/backend/dist/fixture-platform.js');
 writeFileSync(entry,'export { __fixturePlatform as platform } from '+JSON.stringify('./'+relative(join(root,'apps/backend/dist'),file))+';\n');
 return entry;
}

/** Inject into the matching shipped module, including its immutable target copy after handoff. */
export function bundledPlatformPreload(root: string, body: string): string {
 const file=backendBundleWith(root,'platform = selectHost()'),suffix='/'+relative(root,file);
 return `import { registerHooks } from 'node:module';
 const suffix = ${JSON.stringify(suffix)};
 registerHooks({load(url, context, nextLoad) {
   const loaded = nextLoad(url, context);
   return url.endsWith(suffix) ? {...loaded, source: loaded.source + ${JSON.stringify('\n'+body+'\n')}} : loaded;
 }});\n`;
}
