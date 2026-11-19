/** Installation wiring only: no denied command or network connection is attempted. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const root = mkdtempSync(join(tmpdir(), "alpacawork-guard-wiring-"));
after(() => rmSync(root, { recursive: true, force: true }));
const guard = join(root, "local-hook.mjs"), noop = join(root, "no-hook.mjs");
writeFileSync(guard, `import cp from 'node:child_process'; import net from 'node:net';
import {syncBuiltinESMExports} from 'node:module';
globalThis.localHookLoads=(globalThis.localHookLoads??0)+1;
const spawn=cp.spawn, connect=net.Socket.prototype.connect;
cp.spawn=function(...args){return spawn.apply(this,args)};
net.Socket.prototype.connect=function(...args){return connect.apply(this,args)};
syncBuiltinESMExports();`);
writeFileSync(noop, "export {};\n");
const loader = new URL("./guard-loader.mjs", import.meta.url).href;
const assertions = new URL("./guard.ts", import.meta.url).href;
const fixtures = new URL("./fixtures.ts", import.meta.url).href;
const selected = { ALPACAWORK_E2E_BACKEND_GUARD: guard, ALPACAWORK_E2E_GUARD_REQUIRED: "1",
  ALPACAWORK_E2E_GUARD_SHA256: createHash("sha256").update(readFileSync(guard)).digest("hex") };
function run(code: string, extra: NodeJS.ProcessEnv = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("ALPACAWORK_E2E_GUARD_") || key === "ALPACAWORK_E2E_BACKEND_GUARD" || key === "NODE_OPTIONS") delete env[key];
  return spawnSync(process.execPath, ["--input-type=module", "-e", code], { env: { ...env, ...extra }, encoding: "utf8", timeout: 15_000 });
}
const body = `import {assertGuardLoaded} from ${JSON.stringify(assertions)};
assertGuardLoaded('before-serve-sentinel'); console.log('serve-sentinel');`;

test("guard is optional when the execution did not select it", () => {
  const result = run(body, { NODE_OPTIONS: `--import=${loader}` });
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /serve-sentinel/);
});
test("required selection missing stops before the serve sentinel", () => {
  const result = run(body, { ALPACAWORK_E2E_GUARD_REQUIRED: "1", NODE_OPTIONS: `--import=${loader}` });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /no guard selected/); assert.equal(result.stdout, "");
});
test("omitting the preload is caught before the serve sentinel", () => {
  const result = run(body, selected);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /not loaded before before-serve-sentinel/); assert.equal(result.stdout, "");
});
test("an inert module cannot stand in for completed hook installation", () => {
  const result = run(body, { ...selected, ALPACAWORK_E2E_BACKEND_GUARD: noop, ALPACAWORK_E2E_GUARD_SHA256: "", NODE_OPTIONS: `--import=${loader}` });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /did not install process\/network hooks/); assert.equal(result.stdout, "");
});
test("wrong selected digest stops before loading or the serve sentinel", () => {
  const result = run(body, { ...selected, ALPACAWORK_E2E_GUARD_SHA256: "0".repeat(64), NODE_OPTIONS: `--import=${loader}` });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /digest mismatch/); assert.equal(result.stdout, "");
});
test("preload and config import install once before named ESM consumers", () => {
  const result = run(`import ${JSON.stringify(loader)};
    import {spawn} from 'node:child_process'; import cp from 'node:child_process';
    import {assertGuardLoaded} from ${JSON.stringify(assertions)};
    const guard=assertGuardLoaded('direct-runtime');
    console.log(JSON.stringify({loads:globalThis.localHookLoads,pid:guard.pid,actualPid:process.pid,synced:spawn===cp.spawn,options:process.env.NODE_OPTIONS}));`,
  { ...selected, NODE_OPTIONS: `--import=${loader}` });
  assert.equal(result.status, 0, result.stderr);
  const actual = JSON.parse(result.stdout);
  assert.equal(actual.loads, 1); assert.equal(actual.pid, actual.actualPid); assert.equal(actual.synced, true);
  assert.equal(actual.options.split(/\s+/).filter((v: string) => v === `--import=${loader}`).length, 1);
});
test("cleanEnv retains the preload for keeper and serve child processes", () => {
  const clean = new URL("../tests/acceptance/processes.ts", import.meta.url).href;
  const child = `import {assertGuardLoaded} from ${JSON.stringify(assertions)};const guard=assertGuardLoaded('child-serve'); console.log(JSON.stringify({pid:guard.pid,loads:globalThis.localHookLoads}));`;
  const result = run(`import {cleanEnv} from ${JSON.stringify(clean)};import {spawnSync} from 'node:child_process';
    const result=spawnSync(process.execPath,['--input-type=module','-e',${JSON.stringify(child)}],{env:cleanEnv(),encoding:'utf8'});
    if(result.status!==0)throw Error(result.stderr); console.log(JSON.stringify({parent:process.pid,child:JSON.parse(result.stdout)}));`,
  { ...selected, NODE_OPTIONS: `--import=${loader}` });
  assert.equal(result.status, 0, result.stderr);
  const actual = JSON.parse(result.stdout); assert.notEqual(actual.parent, actual.child.pid); assert.equal(actual.child.loads, 1);
});
test("derived direct runtimes cannot bypass the shared fixture precondition", () => {
  const result = run(`await import(${JSON.stringify(fixtures)}); console.log('serve-sentinel');`, selected);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /not loaded before fixture-module/); assert.equal(result.stdout, "");
});
test("the child serve entry refuses a lost preload before creating a listener", () => {
  const script = new URL("./serve-main.ts", import.meta.url).href;
  const result = run(`process.argv=['node','serve-main','${root}','0','1000'];await import(${JSON.stringify(script)});`, selected);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /not loaded before child-serve/); assert.equal(result.stdout, "");
});

test('file-backed guard evidence leaves the real CLI error channel parseable and retains same-PID preload ordering', () => {
  const log=join(root,'channel-evidence.jsonl');
  const result=run(`import {assertGuardLoaded} from ${JSON.stringify(assertions)};
    const guard=assertGuardLoaded('cli-error-consumer');
    process.stderr.write(JSON.stringify({error:{code:'conflict'},pid:process.pid}));`,
    {...selected,ALPACAWORK_E2E_GUARD_LOG:log,NODE_OPTIONS:`--import=${loader}`});
  assert.equal(result.status,0,result.stderr);
  const cli=JSON.parse(result.stderr),rows=readFileSync(log,'utf8').trim().split('\n').map(line=>JSON.parse(line));
  assert.equal(cli.error.code,'conflict');
  assert.deepEqual(rows.map(row=>[row.boundary,row.pid]),[['preload-complete',cli.pid],['cli-error-consumer',cli.pid]]);
});
