import { createHash } from 'node:crypto';

import { boundBridgeEvent, type BridgeEvent, type BridgeInstruction, type CompactionRequest } from '@alpacawork/contract/agent-bridge';
export type Instruction = BridgeInstruction;
/** How compacting a conversation ended; `message` is the agent's own account of a failure. */
export type CompactionResult = { compacted: true } | { compacted: false; message: string };
/** RPC admission is not a receipt. Once deliver is called, failure cannot prove non-delivery. */
export type Admission = { state: 'transferred' } | { state: 'uncertain'; message: string };
export type Runtime = {
  start(): Promise<void>;
  deliver(input: Instruction): Promise<Admission>;
  /** Compact the conversation with its own model while no turn runs. It is no turn: no turn events, receipts or result file.
   * `instructions` is for an agent that takes them; one that cannot use them ignores them. */
  compact(instructions: string | null): Promise<CompactionResult>;
  idle(): boolean;
  turns(): number;
  failed(): boolean;
  /** Can come while `start` waits, since input is read during it. `start` then opens nothing more and what it opened stops; nothing waits for it. */
  close(): void | Promise<void>;
};
export type RuntimeIO = {
  emit(event: BridgeEvent): void;
  started(id: string): void;
  idle(): void;
  fatal(error: Error): void;
};

type Pending = { contentDigest: string; transferStarted: boolean; admitted: boolean;
  outcome: 'taken' | 'not_sent' | 'uncertain' | null };
export function run(create: (io: RuntimeIO) => Runtime): void {
  let finishing = false, stdinOpen = true, received = 0;
  let work: Promise<void> = Promise.resolve();
  let runtime: Runtime;
  // Keep identity and receipt evidence after uncertainty: a delayed started still settles the same ID.
  const pending = new Map<string, Pending>();
  // Every line a bridge writes goes here, kept under the outcome reader's line limit whatever it holds.
  const emit = (event: BridgeEvent) => process.stdout.write(`${JSON.stringify(boundBridgeEvent(event))}\n`);
  const outcome = (id: string, message: string): void => {
    const input = pending.get(id)!;
    if (input.outcome === 'taken' || input.outcome === 'not_sent') return;
    const state = input.transferStarted ? 'uncertain' : 'not_sent';
    if (input.outcome === state) return;
    input.outcome = state;
    emit(state === 'not_sent' ? { type: 'input.not_sent', id, message, evidence: 'transfer_not_started' }
      : { type: 'input.uncertain', id, message });
  };
  const started = (id: string): void => {
    const input = pending.get(id);
    if (!input || !input.transferStarted || input.outcome === 'taken') return;
    if (input.outcome === 'not_sent') { fatal(new Error(`Contradictory receipt for ${id}`)); return; }
    if (!input.admitted) { input.admitted = true; emit({ type: 'input.accepted', id }); }
    input.outcome = 'taken';
    emit({ type: 'input.taken', id });
  };
  let closing: Promise<void> | null = null;
  const close = (message: string): Promise<void> => {
    if (closing) return closing;
    finishing = true;
    for (const id of pending.keys()) outcome(id, message);
    closing = Promise.resolve(runtime?.close());
    return closing;
  };
  const fatal = (error: Error): void => {
    if (finishing) return;
    void close(error.message).catch(failure => { process.stderr.write(`alpacawork-agent: cleanup failed: ${String(failure)}\n`); });
    process.stderr.write(`alpacawork-agent: ${error.message}\n`);
    process.exitCode = 1;
    process.stdin.destroy();
  };
  const idle = (turnEnded = true): void => {
    if (turnEnded) for (const [id, input] of pending)
      if (input.transferStarted) outcome(id, 'Agent turn ended without a processing receipt');
    if (stdinOpen || finishing || !runtime.idle()) return;
    void work.then(async () => {
      if (finishing || !runtime.idle()) return;
      if (received === 0) process.stderr.write('alpacawork-agent: no instruction arrived on stdin\n');
      process.exitCode = received === 0 || runtime.turns() === 0 || runtime.failed() ? 1 : 0;
      await close('Agent stopped without a processing receipt');
    }).catch(error => {
      if (!finishing) fatal(error);
      else { process.stderr.write(`alpacawork-agent: cleanup failed: ${String(error)}\n`); process.exitCode = 1; }
    });
  };
  runtime = create({ emit, started, idle: () => idle(), fatal });
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.once(signal, () => {
    const stopped = close(`Agent stopped by ${signal}`);
    process.stdin.destroy();
    const code = 128 + (signal === 'SIGINT' ? 2 : signal === 'SIGHUP' ? 1 : 15);
    process.exitCode = code;
    void stopped.catch(error => process.stderr.write(`alpacawork-agent: cleanup failed: ${String(error)}\n`))
      .then(() => process.stdout.write('', () => process.exit(code)));
  });
  // Read before start: an instruction seen before a failed start is provably not sent. Only this chain calls deliver.
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let buffered = '';
  // Compaction comes before its instruction's transfer: the instruction is provably not sent while it runs, and a failed
  // compaction is told and never keeps the instruction from its turn.
  const compact = async (request: CompactionRequest): Promise<void> => {
    let result: CompactionResult;
    if (!runtime.idle()) result = { compacted: false, message: 'Compaction was skipped because a turn is running' };
    else try { result = await runtime.compact(request.instructions); }
    catch (error) { result = { compacted: false, message: error instanceof Error ? error.message : String(error) }; }
    if (finishing) return;
    emit(result.compacted ? { type: 'compaction.completed' } : { type: 'compaction.failed', message: result.message });
  };
  const acceptLine = (line: string): void => {
    let value: { id?: unknown; text?: unknown; compact?: unknown };
    try { value = JSON.parse(line); } catch { value = {}; }
    const request = compactionRequest(value?.compact);
    if (typeof value?.id !== 'string' || typeof value.text !== 'string' || !value.text || request === false) {
      process.stderr.write('alpacawork-agent: ignored an input line without id and text\n'); return;
    }
    const input = { id: value.id, text: value.text };
    const digest = createHash('sha256').update(JSON.stringify([input.text, request])).digest('hex');
    const prior = pending.get(input.id);
    if (prior) {
      if (prior.contentDigest !== digest) fatal(new Error(`Input ID reused with different content: ${input.id}`));
      // No second deliver, even when the first admission response was lost.
      return;
    }
    received++;
    const record: Pending = { contentDigest: digest, transferStarted: false, admitted: false, outcome: null };
    pending.set(input.id, record);
    work = work.then(async () => {
      if (request && !finishing) await compact(request);
      if (finishing) { outcome(input.id, 'Bridge closed before transfer'); return; }
      record.transferStarted = true;
      let admission: Admission;
      try { admission = await runtime.deliver(input); }
      catch (error) { outcome(input.id, String(error)); throw error; }
      if (record.outcome === 'taken' || record.outcome === 'uncertain') return;
      if (admission.state === 'uncertain') outcome(input.id, admission.message);
      else { record.admitted = true; emit({ type: 'input.accepted', id: input.id }); }
    }).catch(fatal);
  };
  // JSONL is LF-framed. readline also splits U+2028/U+2029 inside legitimate JSON strings.
  process.stdin.on('data', (chunk: Buffer) => {
    try {
      buffered += decoder.decode(chunk, { stream: true });
      for (let end = buffered.indexOf('\n'); end !== -1; end = buffered.indexOf('\n')) {
        const line = buffered.slice(0, end); buffered = buffered.slice(end + 1); acceptLine(line);
      }
    } catch (error) { fatal(error instanceof Error ? error : new Error(String(error))); }
  });
  process.stdin.once('end', () => {
    try { buffered += decoder.decode(); if (buffered) acceptLine(buffered); }
    catch (error) { fatal(error instanceof Error ? error : new Error(String(error))); }
    buffered = ''; stdinOpen = false; idle(false);
  });
  process.stdin.once('close', () => { stdinOpen = false; idle(false); });
  work = new Promise<void>(resolve => resolve(runtime.start())).catch(fatal);
}

/** An input line's optional `compact`: null when absent, false when malformed. */
function compactionRequest(value: unknown): CompactionRequest | null | false {
  if (value === undefined) return null;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const { instructions } = value as { instructions?: unknown };
  return instructions === null || typeof instructions === 'string' ? { instructions } : false;
}
