/** Observes one invocation. No control DB, settings, credential key, scheduler or reply routing is reachable here. */
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fstatSync,lstatSync } from 'node:fs';
import { bootIdentity, digestBytes, platform, processIdentity, publishImmutable } from '@alpacawork/core';
import { RUN_FILES } from '@alpacawork/contract/run';
import type { LaunchSnapshot, RunCommand } from '@alpacawork/contract/run-protocol';
import { launchAgent, launchArgv, runScope } from './launch-agent.js';
import { EventJournal, executionFolder, identityOf, readLaunch, readCommands, names } from './execution-files.js';
import { runtimeAdapter, unavailableRuntimeMessage } from '../agents/registry.js';
import { OutputActivityReader } from './activity.js';
import { recordReportedContext } from '../agents/context-reported.js';
import { appendReceipt, endOutcome, publishCompletion, readEnd, runExpired, type Outcome } from './result-observation.js';
import { CommandWatch } from './command-watch.js';
import { terminateAgent } from './termination.js';
import { POLL_INTERVAL_MS } from '../poll-interval.js';
import { inputAwaitsReceipt, localStopSchema, PROTOCOL_LIMITS } from '@alpacawork/contract/run-protocol';
import { releaseForEntry } from '@alpacawork/core';
import { fileURLToPath } from 'node:url';
import { readImmutable, strictJson } from '@alpacawork/core';

export { launchArgv };
function localStop(root: string, launch: LaunchSnapshot): string | null {
  const folder = join(root, '.alpacawork', 'local-stops');
  for (const name of names(folder)) {
    const stop = localStopSchema.parse(strictJson(readImmutable(folder, name, PROTOCOL_LIMITS.command)));
    if (stop.workspaceId !== launch.workspaceId) throw new Error('Local stop workspace mismatch');
    if (stop.targetRunId === launch.runId || launch.ancestors.includes(stop.targetRunId)) return stop.operationId;
  }
  return null;
}
export async function manageRun(root: string, id: string, attempt: string): Promise<void> {
  await observeRun(root, id, attempt);
}
async function observeRun(root: string, id: string, attempt: string): Promise<void> {
  // fd 3's ownership starts before this entry. It must never be inherited by the agent.
  if (!fstatSync(3).isFile()) throw new Error('Manager lock fd 3 is missing');
  const snapshot = readLaunch(root, id, attempt), identity = identityOf(snapshot);
  // Serve reserves a coordinator's turn, and only it, without a Run credential; this process reads no Run record.
  const coordinator = snapshot.credential === null;
  const adapter = runtimeAdapter(snapshot.invocation.launch.adapter);
  const adapterInvocation = { mode: snapshot.invocation.mode, session: snapshot.invocation.session?.id ?? null };
  const folder = join(root, '.alpacawork', 'runs', id), spool = executionFolder(root, id, attempt);
  const journal = new EventJournal(spool, identity);
  const own = processIdentity(process.pid);
  publishImmutable(spool, 'claim.json', JSON.stringify({ ...identity, nonce: randomUUID(), pid: process.pid,
    started: own.started, bootId: own.bootId }));
  journal.append('claimed', { managerPid: process.pid, managerStarted: own.started, bootId: own.bootId });
  let cause: 'stopped' | 'timeout' | null = null;
  const observedInputs = new Map<string, 'attempted' | 'taken' | 'not_sent' | 'uncertain'>();
  const notSent = (inputId: string) => {
    observedInputs.set(inputId, 'not_sent');
    journal.append('input_not_sent', { inputId, evidence: 'write_not_called', receipt: null });
  };
  const processed = new Set<number>(), cancelled = new Set<string>();
  let nextCommand = 1;
  const observeStop = (commands: RunCommand[]) => {
    const stop = commands.find(c => c.type === 'stop'), local = localStop(root, snapshot);
    if (cause === null && (stop || local)) {
      cause = 'stopped'; journal.append('stop_observed', { reason: cause, commandId: stop?.commandId ?? local });
    }
    for (const command of commands) if (command.type === 'cancel-input' && command.inputId) cancelled.add(command.inputId);
  };
  // No agent ran, so nothing but the outcome can be observed.
  const completeUnlaunched = (outcome: Outcome, message?: string) => publishCompletion(journal, { outcome,
    finalResult: message === undefined ? { state: 'missing', text: null } : { state: 'present', text: message },
    session: snapshot.invocation.session?.id ?? null, measuredUsage: null, exit: null });
  const first = readCommands(spool, identity); observeStop(first.commands);
  if (cause) {
    notSent(snapshot.initialInputId);
    completeUnlaunched({ state: 'cancelled', reason: 'stopped' });
    return;
  }
  if (first.faults.length) throw new AggregateError(first.faults, 'Invalid commands before spawn');
  if (!adapter) {
    notSent(snapshot.initialInputId);
    completeUnlaunched({ state: 'failed', reason: 'launch' }, unavailableRuntimeMessage(snapshot.invocation.launch.adapter));
    return;
  }
  try { if (snapshot.release !== releaseForEntry(fileURLToPath(import.meta.url))) throw new Error('Manager code image differs from its launch'); }
  catch (error) { console.error('Run release selection failed', error); notSent(snapshot.initialInputId);
    completeUnlaunched({ state: 'failed', reason: 'launch' }); return; }
  try { lstatSync(join(folder, RUN_FILES.resultTemp)); throw new Error('Unreconciled temporary result requires review'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  journal.append('spawn_intent', { initialInputId: snapshot.initialInputId });
  const attemptInput = (inputId: string, instructionRunId: string, text: string) => {
    if (observedInputs.has(inputId)) throw new Error('Input attempted twice');
    journal.append('input_attempt', { inputId, instructionRunId, contentDigest: digestBytes(text) });
    observedInputs.set(inputId, 'attempted');
  };
  let launched: Awaited<ReturnType<typeof launchAgent<string>>>;
  try {
    // Without a Run credential the agent calls as the conversation it speaks for, with the server alone.
    launched = await launchAgent<string>({ invocation: snapshot.invocation, folder, root, cwd: snapshot.cwd,
      release: snapshot.release, env: { ...(snapshot.credential === null ? {} : { ALPACAWORK_RUN: id, ALPACAWORK_RUN_TOKEN: snapshot.credential }),
        ...(snapshot.server ? { ALPACAWORK_SERVER: snapshot.server } : {}) } });
  } catch (error) {
    console.error('Invocation launch failed', error);
    if (observedInputs.has(snapshot.initialInputId)) journal.append('input_uncertain', { inputId: snapshot.initialInputId, receipt: null });
    else notSent(snapshot.initialInputId);
    completeUnlaunched({ state: 'failed', reason: 'launch' });
    return;
  }
  const { child, channel, exited, spawnedAt } = launched;
  let termination: Promise<void> | undefined;
  let channelClosed = false, groupSettled = false, unitSettled = false, failed = false;
  const launch = snapshot.invocation.launch;
  const activity = new OutputActivityReader(adapter, undefined,
    update => { try { recordReportedContext(root, launch.adapter, launch.values.model ?? null, update); }
      catch (error) { console.error('Reported context could not be kept', error); } });
  const finishActivity = (state: 'done' | 'failed') => {
    try { activity.finish(folder, state); } catch (error) { console.error('Activity finish failed', error); }
  };
  const closeChannel = () => { if (!channelClosed) { channel.close(); channelClosed = true; } };
  const transfer = (open: typeof channel, inputId: string, instructionRunId: string, text: string) => {
    attemptInput(inputId, instructionRunId, text);
    if (!open.write(instructionRunId, text, inputId)) notSent(inputId);
  };
  try {
    journal.append('started', processIdentity(child.pid!));
    transfer(channel, snapshot.initialInputId, id, snapshot.prompt);
    let session = snapshot.invocation.session?.id ?? null, finished = false;
    const takeReceipts = () => {
      for (const receipt of channel.poll(folder, session).receipts) {
        const prior = observedInputs.get(receipt.id);
        if (prior === 'taken' || prior === receipt.outcome) continue;
        if (!prior) throw new Error(`Unattempted receipt: ${receipt.id}`);
        if (prior === 'not_sent' && receipt.outcome === 'taken') throw new Error('Contradictory receipt');
        observedInputs.set(receipt.id, receipt.outcome);
        appendReceipt(journal, receipt);
      }
    };
    // A launch recorded before command limits has none to watch, as when it was recorded.
    const commands = coordinator && snapshot.commandSeconds != null ? new CommandWatch(child.pid!, snapshot.commandSeconds, runScope(root, id, own.scope), journal) : null;
    const tick = () => {
      const scan = readCommands(spool, identity);
      // Stop and cancellation bypass normal sequence and provider receipt waits.
      observeStop(scan.commands);
      if (cause === null && runExpired(snapshot.runMinutes, performance.now() - spawnedAt)) {
        cause = 'timeout'; journal.append('stop_observed', { reason: cause, commandId: null });
      }
      if (cause && !termination) {
        journal.append('termination_started', { pid: child.pid! });
        termination = terminateAgent(child.pid!);
        // Attach immediately; await below retains and propagates failure.
        void termination.catch(() => undefined);
      }
      if (!cause && !finished) commands?.tick();
      if (scan.faults.length && !cause) throw new AggregateError(scan.faults, 'Invalid execution command');
      if (session === null) {
        session = adapter.earlySession(adapterInvocation, folder);
        if (session) journal.append('session', { id: session });
      }
      takeReceipts();
      try { activity.poll(folder); } catch (error) { console.error('Activity projection failed', error); }
      for (const command of scan.commands) {
        if (processed.has(command.seq)) continue;
        if (command.seq !== nextCommand) { if (cause) continue; throw new Error(`Command sequence gap at ${nextCommand}`); }
        if (command.type === 'input') {
          // Only the head input is delivered until its processing receipt settles.
          if ([...observedInputs.values()].some(inputAwaitsReceipt)) break;
          if (cancelled.has(command.inputId!) || cause || !channel.open || finished) notSent(command.inputId!);
          else transfer(channel, command.inputId!, command.instructionRunId!, command.text!);
        }
        processed.add(command.seq); nextCommand++;
      }
    };
    let rejectPoll!: (error: unknown) => void;
    const pollFailed = new Promise<never>((_, reject) => { rejectPoll = reject; });
    const timer = setInterval(() => { try { tick(); } catch (error) { rejectPoll(error); } }, POLL_INTERVAL_MS);
    let exit: Awaited<typeof exited>;
    try { tick(); exit = await Promise.race([exited, pollFailed]); }
    finally { clearInterval(timer); }
    finished = true;
    tick(); closeChannel(); takeReceipts();
    if (termination) await termination;
    // A process can leave children behind on natural exit; completion requires the entire group to end.
    const groupLeft = platform.run.signalGroup(child.pid!, 0);
    if (groupLeft) {
      journal.append('termination_started', { pid: child.pid! }); await terminateAgent(child.pid!);
    }
    groupSettled = true;
    // Nothing this Run started outlives it, including commands that left the agent's group but stayed in its unit.
    const unitLeft = await platform.run.stopUnitOthers(); unitSettled = true;
    journal.append('exited', exit);
    for (const [inputId, state] of observedInputs) if (state === 'attempted') {
      journal.append('input_uncertain', { inputId, receipt: { evidence: 'process_ended_without_receipt' } });
      observedInputs.set(inputId, 'uncertain');
    }
    const output = adapter.read(adapterInvocation, folder, exit);
    const end = readEnd({ outcome: endOutcome(cause, output.outcome), observed: output, exit, measured: true,
      interrupted: !!termination || groupLeft || unitLeft || !!commands?.interrupted });
    finishActivity(end.outcome.state === 'succeeded' ? 'done' : 'failed');
    publishCompletion(journal, end);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    // The launched child belongs to this scope even when an observation or
    // journal write fails. Preserve that failure and leave completion to serve.
    const cleanupErrors: unknown[] = [];
    try { closeChannel(); } catch (error) { cleanupErrors.push(error); }
    if (!groupSettled) try {
      if (termination) await termination;
      else await terminateAgent(child.pid!);
    } catch (error) { cleanupErrors.push(error); }
    if (!unitSettled) try { await platform.run.stopUnitOthers(); }
    catch (error) { cleanupErrors.push(error); }
    if (failed) finishActivity('failed');
    if (cleanupErrors.length) {
      if (failed) console.error('Run manager cleanup failed', new AggregateError(cleanupErrors));
      else throw new AggregateError(cleanupErrors, 'Run manager cleanup failed');
    }
  }
}
