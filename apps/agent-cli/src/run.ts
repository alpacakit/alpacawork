import { createHash } from 'node:crypto';

import type { BridgeEvent, BridgeInstruction } from '@alpacawork/contract/agent-bridge';
export type Instruction = BridgeInstruction;
/** RPC admission is not a receipt. Once deliver is called, failure cannot prove non-delivery. */
export type Admission = { state: 'transferred' } | { state: 'uncertain'; message: string };
export type Runtime = {
  start(): Promise<void>;
  deliver(input: Instruction): Promise<Admission>;
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
  const emit = (event: BridgeEvent) => process.stdout.write(`${JSON.stringify(event)}\n`);
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
  const acceptLine = (line: string): void => {
    let value: { id?: unknown; text?: unknown };
    try { value = JSON.parse(line); } catch { value = {}; }
    if (typeof value.id !== 'string' || typeof value.text !== 'string' || !value.text) {
      process.stderr.write('alpacawork-agent: ignored an input line without id and text\n'); return;
    }
    const input = { id: value.id, text: value.text };
    const prior = pending.get(input.id);
    if (prior) {
      if (prior.contentDigest !== createHash('sha256').update(input.text).digest('hex')) fatal(new Error(`Input ID reused with different content: ${input.id}`));
      // No second deliver, even when the first admission response was lost.
      return;
    }
    received++;
    const record: Pending = { contentDigest: createHash('sha256').update(input.text).digest('hex'), transferStarted: false, admitted: false, outcome: null };
    pending.set(input.id, record);
    work = work.then(async () => {
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
