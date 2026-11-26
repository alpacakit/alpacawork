// Last-resort lifetime for this test-owned process; normal cleanup closes it first.
setTimeout(() => process.exit(124), 150000).unref();
/**
 * A real stdin/stdout process for coordinator delivery tests. Gates are confined to the temporary workspace, whose
 * root it is given; it works in the coordinator's own folder below it.
 */
import { createInterface } from 'node:readline';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
const args = process.argv.slice(2), native = args.includes('--fixture-native'), resumed = args.includes('resume') || args.includes('--resume');
const session = native ? args[args.indexOf(resumed ? '--resume' : '--session-id') + 1] : resumed ? args.at(-1) : 'synthetic-coordinator-input', result = args[args.indexOf('-o') + 1], workspace = process.env.ALPACAWORK_WORKSPACE;
if (existsSync(join(workspace, 'ignore-stop'))) process.on('SIGTERM', () => {});
const prompts = [];
const joinedComments = [];
const event = value => process.stdout.write(JSON.stringify(value) + '\n');
if (!native) event({ type: 'thread.started', thread_id: session });
const taken = id => event(native ? { type: 'command_lifecycle', state: 'started', command_uuid: id, session_id: session } : { type: 'input.taken', id });
const wait = async path => { while (!existsSync(path)) await delay(10); };
for await (const line of createInterface({ input: process.stdin })) {
  const input = JSON.parse(line);
  const id = native ? input.uuid : input.id, rawPrompt = native ? input.message.content : input.text;
  prompts.push(rawPrompt);
  const prompt = rawPrompt.split(/^Request ID of this input: [^\n]+\n/m).at(-1);
  if (prompts.length > 1 && prompt === 'refuse') { event({ type: 'input.uncertain', id }); continue; }
  if (prompts.length > 1 && prompt === 'untaken') continue;
  if (prompts.length > 1 && prompt.startsWith('take:')) {
    void wait(prompt.slice(5)).then(() => taken(id)); continue;
  }
  taken(id);

  if (existsSync(join(workspace, 'comment-on-joined'))) {
    const sourceRequest = /Request ID of this input: ([0-9a-f-]+)/.exec(rawPrompt)?.[1];
    if (prompts.length === 1 && sourceRequest) writeFileSync(join(workspace, 'comment-head-started'), sourceRequest);
    const comment = /^comment-immediately:(\{.*\})$/m.exec(prompt);
    if (prompts.length > 1 && comment) {
      if (!sourceRequest) throw Error('Joined comment needs its explicit source Request');
      const target = JSON.parse(comment[1]);
      // No HTTP read or joined-state wait occurs between the taken event and this real CLI write.
      const argv = ['task', 'comment', '--task', target.task, '--title', 'Immediate joined comment',
        '--expected-task-hash', target.hash, '--source-request', sourceRequest, '--op-id', randomUUID()];
      const result = spawnSync(process.execPath, [new URL('../../apps/cli/dist/cli.js', import.meta.url).pathname, ...argv],
        { encoding: 'utf8', env: { ...process.env, [native ? 'CLAUDE_CODE_SESSION_ID' : 'CODEX_THREAD_ID']: session } });
      joinedComments.push({ sourceRequest, code: result.status,
        output: JSON.parse(result.status === 0 ? result.stdout : result.stderr) });
      writeFileSync(join(workspace, 'joined-comment-result.json'), JSON.stringify(joinedComments.at(-1)));
    }
  }
  if (prompts.length > 1 && ['crash', 'missing'].includes(prompt)) process.exit(prompt === 'crash' ? 2 : 0);
  if (prompts.length === 1) {
    writeFileSync(join(workspace, 'agent-started'), String(process.pid));
    const gate = /^hold:(.+)$/m.exec(prompt)?.[1];
    void (async () => {
      if (gate) await wait(gate);
      let approval;
      const intent = /^confirm-review:(\{.*\})$/m.exec(prompt);
      if (existsSync(join(workspace, 'approve-after-joined')) && intent) {
        const action = JSON.parse(intent[1]), sourceRequest = /Request ID of this input: ([0-9a-f-]+)/.exec(rawPrompt)?.[1];
        if (!sourceRequest) throw Error('Approval fixture needs its explicit source Request');
        writeFileSync(join(workspace, 'approval-waiting'), sourceRequest);
        await wait(join(workspace, 'approval-release'));
        const argv = ['task', 'report', '--task', action.task, '--state', 'done', '--op-id', randomUUID(),
          '--expected-task-hash', action.expectedTaskHash, '--source-request', sourceRequest,
          ...(action.aboutRun ? ['--about-run', action.aboutRun] : []),
          ...(action.expectedPlacementRevision ? ['--expected-placement-revision', String(action.expectedPlacementRevision)] : [])];
        const result = spawnSync(process.execPath, [new URL('../../apps/cli/dist/cli.js', import.meta.url).pathname, ...argv],
          { encoding: 'utf8', env: { ...process.env, [native ? 'CLAUDE_CODE_SESSION_ID' : 'CODEX_THREAD_ID']: session } });
        approval = { sourceRequest, code: result.status, output: JSON.parse(result.status === 0 ? result.stdout : result.stderr) };
      }
      // Let the server observe delivery receipts before process exit in normal cases.
      await delay(100);
      const answer = JSON.stringify({ prompts, ...(approval ? { approval } : {}),
        ...(joinedComments.length ? { joinedComments } : {}) });
      if (native) event({ type: 'result', session_id: session, is_error: false, result: answer });
      else { writeFileSync(result, answer); event({ type: 'turn.completed' }); }
      process.exit(0);
    })();
  }
}
