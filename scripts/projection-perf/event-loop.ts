/** Node preload used only by the synthetic measurement command, including when the target is an older main build. */
import { monitorEventLoopDelay } from 'node:perf_hooks';
if (process.argv[1]?.endsWith('/backend.js')) {
const histogram = monitorEventLoopDelay({ resolution: 1 });
histogram.enable();
const publish = () => {
  if (histogram.count) console.error(JSON.stringify({ timing: new Date().toISOString(), step: 'event-loop', pid: process.pid,
    longestStallMs: Math.max(0, histogram.max / 1e6 - 1), samples: histogram.count }));
  histogram.reset();
};
const timer = setInterval(publish, 1000); timer.unref();
process.once('beforeExit', () => { publish(); histogram.disable(); clearInterval(timer); });

}
