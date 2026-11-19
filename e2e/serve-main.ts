/** E2E-only composition. The shipped server does not expose a fixture mutation endpoint. */
import { startServer } from './fixture/server.ts';
import { fixtureWriter } from './fixture-writes.ts';
import { assertGuardLoaded } from './guard.ts';
import { POLL_INTERVAL_MS } from '@alpacawork/backend/test-dist/poll-interval.js';
const [root,port,backstop]=process.argv.slice(2);if(!root||!port||!backstop)throw Error('Expected root, port and backstop');
assertGuardLoaded('child-serve');
// The server's reconciliation timer first fires one period after it listens, and start() waits for that pass: about a
// tenth of E2E's seconds, with nothing happening in them. Its first tick runs as soon as the server is up; later ticks
// keep the product's period. Refusing an unexpected timer keeps a changed period from quietly costing that wait again.
const productInterval=globalThis.setInterval,ticks:(()=>void)[]=[];
globalThis.setInterval=((run:()=>void,ms:number,...rest:unknown[])=>{if(ms===POLL_INTERVAL_MS)ticks.push(run);return productInterval(run,ms,...rest)})as typeof setInterval;
const app=await startServer(root,Number(port),{timing:true}),closeFixtures=await fixtureWriter(root,()=>{app.recordsChanged();return app.filesChanged()});
globalThis.setInterval=productInterval;
if(ticks.length!==1)throw Error(`Expected one reconciliation timer of ${POLL_INTERVAL_MS} ms, found ${ticks.length}`);
ticks[0]!();
let closing:Promise<void>|undefined;const close=()=>closing??=(async()=>{await closeFixtures();await app.close();process.exit(0)})();
// Whoever started this serve holds its stdin, so a serve lives as long as its runner however the runner ends, keeper or no keeper.
process.stdin.resume().once('end',()=>void close());
// Only a runner that is still there but never finishes reaches this clock, so it says what stopped the server the later cases cannot reach.
const expiry=setTimeout(()=>{console.error(`[e2e] serve stopped at its backstop of ${backstop} ms: ${root}`);void close()},Number(backstop));process.once('SIGTERM',()=>void close());process.on('exit',()=>clearTimeout(expiry));
console.log(JSON.stringify({url:app.url,publicUrl:app.publicUrl,connection:app.connection,root}));
