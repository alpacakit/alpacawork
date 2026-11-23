import { receiveFullIndex } from '../src/data/resources';
import { projectedIndexSchema } from '@alpacawork/contract/control';
import { useConnection } from '../src/data/connection';
import { snapshotJson } from './conversation-fixture';
import { setConversationState } from './conversation-fixture';
/** File input + actual coordinator HTTP. XHR is only a byte transport adapter for jsdom. */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { resolve, join } from 'node:path';
import { cpSync, writeFileSync } from 'node:fs';
import { stringify } from 'yaml';
import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { i18n, startI18n } from '@alpacawork/i18n';
import { CoordinatorInput } from '../src/features/coordinator/CoordinatorInput';
import { CoordinatorThread } from '../src/features/coordinator/CoordinatorThread';
import { ShownConversationProvider } from '../src/features/coordinator/shown';
import { useConversation } from '../src/features/coordinator/coordinator';
import { useDraftStore } from '../src/features/forms/draft-store';
import { useOutbox } from '../src/features/coordinator/editor/outbox';
import { textDocument } from '../src/features/coordinator/editor/document';
import { queryClient } from '../src/data/query-client';
import { notify, useToasts } from '../src/lib/notify';
import { useViewStore } from '../src/state/view-store';
import { useSitting } from '../src/features/reader/next-question';
import { screenData, TestWorkspace, tree } from './fixtures';
import { httpXHR, type XhrFault } from './http-xhr';

const transport = globalThis.fetch;
const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg=='), x => x.charCodeAt(0));
let stop: (() => Promise<void>) | undefined;
let activeRoot = '';
let faults: XhrFault[] = [];
beforeAll(async () => { await startI18n(); await i18n.changeLanguage('en'); });
afterEach(async ({ task }) => {
  try {
    if (activeRoot && (task.result?.state === 'fail' || faults.length)) {
      writeFileSync(join(activeRoot, 'xhr-diagnostics.json'), JSON.stringify(faults, (_key, value) => value instanceof Error
        ? { name: value.name, message: value.message, stack: value.stack, cause: value.cause } : value, 2));
      cpSync(activeRoot, `/tmp/migration-failures/revision-a-attachment-failure-${Date.now()}`, { recursive: true });
    }
  } finally {
    cleanup(); for (const toast of useToasts.getState().toasts) notify.dismiss(toast.id); vi.restoreAllMocks(); vi.unstubAllGlobals(); await stop?.(); stop = undefined; activeRoot = ''; queryClient.clear();
  }
  expect(faults.filter(fault => fault.phase === 'callback')).toEqual([]);
});
function Surface() {
  const turns = useConversation(state => state.conversation?.turns ?? []);
  return <ShownConversationProvider><CoordinatorThread turns={turns} retry={() => {}} />
    <CoordinatorInput launch={{ next: { agent: 'fake', values: {} }, ready: false }} /></ShownConversationProvider>;
}
async function fixture() {
  faults = [];
  sessionStorage.clear(); useDraftStore.setState({ entries: {}, unavailable: false }); useOutbox.setState({ live: new Set(), resend: null });
  useViewStore.setState(useViewStore.getInitialState()); useSitting.setState(useSitting.getInitialState());
  const env = { ...process.env };
  for (const key of ['ALPACAWORK_RUN', 'ALPACAWORK_RUN_TOKEN', 'ALPACAWORK_SERVER', 'CLAUDE_CODE_SESSION_ID', 'CODEX_SESSION_ID', 'CODEX_THREAD_ID']) delete env[key];
  const child = spawn(process.execPath, [resolve('tests/fixtures/attachment-migration-server.ts')], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  stop = async () => { if (child.exitCode === null && child.signalCode === null) { child.stdin!.end(); await once(child, 'exit'); } };
  let stderr = ''; child.stderr!.on('data', bytes => { stderr += bytes; });
  const lines = createInterface({ input: child.stdout! });
  const line = await Promise.race([once(lines, 'line').then(([line]) => String(line)), once(child, 'exit').then(() => { throw new Error(stderr); })]); lines.close();
  const { origin, root } = JSON.parse(line); activeRoot = root;
  const request = (path: string, init?: RequestInit) => transport(origin + '/api/' + path, init);
  const get = async () => (await (await request('coordinator')).json()).conversation;
  const liveIndex = projectedIndexSchema.parse(await (await request('workspace/live')).json());
  receiveFullIndex(queryClient, liveIndex);
  useConnection.setState({ state: 'live', fresh: true, writable: liveIndex.writable, offline: false });
  useConversation.setState({ root, open: true, expanded: true, engaged: false, wanted: true, error: null });
  const deletions: { id: string; reply: Promise<Response> }[] = [];
  let loseDeletion = false;
  vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) => {
    const reply = transport(new URL(String(url), origin), init).then(response => {
      if (loseDeletion && init?.method === 'DELETE') { loseDeletion = false; expect(response.ok).toBe(true); throw new Error('lost committed deletion reply'); }
      return response;
    });
    if (init?.method === 'DELETE') deletions.push({ id: new Headers(init.headers).get('X-Alpacawork-Op-Id')!, reply });
    return reply;
  });
  await useConversation.getState().refresh();
  const conversation = useConversation.getState().conversation;
  if (!conversation) throw new Error('Fixture did not acquire its conversation through the read Owner');
  let release!: () => void, gate = Promise.resolve();
  const uploads: string[] = [], loaded: string[] = [];
  const uploadReplies = new EventTarget();
  const HttpXHR = httpXHR(origin, { hold: () => gate, sent: path => uploads.push(path), loaded: path => { loaded.push(path); uploadReplies.dispatchEvent(new Event('load')); },
    fault: fault => { faults.push(fault); console.error('[attachment HttpXHR]', fault); } });
  vi.stubGlobal('XMLHttpRequest', HttpXHR);
  const data = screenData(tree({ root }));
  const view = render(<TestWorkspace data={data}><Surface /></TestWorkspace>);
  return { root, origin, request, get, conversation, uploads, loaded, deletions, nextUploadReply: () => once(uploadReplies, 'load'),
    loseDeletion: () => { loseDeletion = true; }, hold: () => { gate = new Promise<void>(resolve => { release = resolve; }); }, release: () => release(),
    limit: async (mib: number) => {
      const response = await request('commands/config/get'); const config = await response.json();
      const saved = await request('commands/config/set', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Alpacawork-Op-Id': crypto.randomUUID() },
        body: snapshotJson({ config: stringify({ limits: { ...config.limits, attachment_mib: mib } }), agents: config.agentsText, expectedConfigHash: config.hash }) });
      expect(saved.status, await saved.clone().text()).toBe(200);
      const index = await (await request('workspace/live')).json();
      await act(async () => { view.rerender(<TestWorkspace data={{ ...data, info: { ...data.info, attachmentBytes: index.attachmentBytes } }}><Surface /></TestWorkspace>); });
    },
  };
}
const upload = (name = 'shot.png', bytes: BlobPart = PNG, type = 'image/png') => fireEvent.change(document.querySelector('input[type=file]')!, { target: { files: [new File([bytes], name, { type })] } });
const cards = () => document.querySelectorAll('[data-attachment]');
const saved = (count: number) => waitFor(() => expect(document.querySelectorAll('[data-attachment-state=saved]')).toHaveLength(count), { timeout: 5_000 });
const field = () => document.querySelector('[data-one-input]')!;
const words = (text: string) => act(() => { (field() as HTMLElement & { editor: import('@tiptap/react').Editor }).editor.commands.setContent(textDocument(text)); });
const send = () => document.querySelector<HTMLButtonElement>('[data-ask-send]')!;

test('same bytes make one card, an upload blocks sending, and a lost real deletion reply retries with the same operation ID', { timeout: 90_000 }, async () => {
  const h = await fixture(); expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Attach' }).disabled).toBe(false);
  upload(); await saved(1);
  await act(async () => {
    const replied = h.nextUploadReply();
    upload('same.png');
    await replied;
  });
  expect(h.uploads).toHaveLength(2); expect(h.loaded).toHaveLength(2);
  await waitFor(() => expect(cards()).toHaveLength(1)); await saved(1);
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Remove shot.png' }));
    expect((await h.deletions[0]!.reply).ok).toBe(true);
  });
  await waitFor(() => expect(cards()).toHaveLength(0));
  // A new card on the same draft: held, it blocks sending; its removal's reply is lost once.
  h.deletions.length = 0; h.hold(); upload();
  await waitFor(() => expect(document.querySelectorAll('[data-attachment-state=uploading]')).toHaveLength(1)); expect(send().disabled).toBe(true);
  h.release(); await saved(1); h.loseDeletion();
  const remove = screen.getByRole<HTMLButtonElement>('button', { name: 'Remove shot.png' });
  // A real write can still be awaiting disk/HTTP while the UI is correctly disabled.
  // Observe its lost reply before checking React's response and making the next click.
  await act(async () => {
    fireEvent.click(remove);
    expect(h.deletions).toHaveLength(1);
    await expect(h.deletions[0]!.reply).rejects.toThrow('lost committed deletion reply');
  });
  expect(remove.disabled).toBe(false);
  await act(async () => {
    fireEvent.click(remove);
    expect(h.deletions).toHaveLength(2);
    expect((await h.deletions[1]!.reply).ok).toBe(true);
  });
  await waitFor(() => expect(cards()).toHaveLength(0)); expect(h.deletions[1]!.id).toBe(h.deletions[0]!.id);
});

test('another client deletion is refused before agent admission; sent attachments remain immutable', { timeout: 90_000 }, async () => {
  const h = await fixture(); upload(); await saved(1);
  const entry = Object.values(useDraftStore.getState().entries).find(entry => entry.values.attachments)!;
  const path = `coordinator/attachments?conversationId=${h.conversation.id}&requestId=${entry.values.requestId}&name=shot.png`;
  const removed = await h.request(path, { method: 'DELETE', headers: { 'X-Alpacawork-Op-Id': crypto.randomUUID() } }); expect(removed.ok).toBe(true);
  words('Missing file must not reach the agent'); fireEvent.click(send());
  await waitFor(() => expect(useToasts.getState().toasts.filter(toast => toast.kind === 'error')).toHaveLength(1)); expect((await h.get()).turns).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: 'Remove shot.png' })); await waitFor(() => expect(cards()).toHaveLength(0));
  upload(); await saved(1); fireEvent.click(send());
  await waitFor(async () => { const current = await h.get(); expect(current.turns.at(-1)?.status).toBe('succeeded'); }, { timeout: 30_000 });
  // The answer is read, as the person reading the conversation does: an unread answer stays folded.
  const answered = (await h.get()).turns.at(-1);
  const read = await h.request('coordinator/read', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Alpacawork-Op-Id': crypto.randomUUID() },
    body: JSON.stringify({ conversationId: h.conversation.id, seen: [answered.id] }) });
  expect(read.status, await read.clone().text()).toBe(200);
  await act(async () => { await useConversation.getState().refresh(); });
  await waitFor(() => expect(document.querySelectorAll('[data-ask-answer]')).toHaveLength(1));
  const payload = (await h.get()).turns.at(-1);
  const denied = await h.request(`coordinator/attachments?conversationId=${h.conversation.id}&requestId=${payload.id}&name=shot.png`, { method: 'DELETE', headers: { 'X-Alpacawork-Op-Id': crypto.randomUUID() } });
  expect(denied.status).toBe(409); expect((await h.request(`coordinator/file?requestId=${payload.id}&name=shot.png`)).ok).toBe(true);
});

test('21 MiB attaches at the default 50 MiB; named failures follow the real configured limit', { timeout: 90_000 }, async () => {
  const h = await fixture(); upload('recording.bin', new Uint8Array(21 * 1024 * 1024).fill(1), 'application/octet-stream'); await saved(1);
  upload('big.bin', new Uint8Array(50 * 1024 * 1024 + 1), 'application/octet-stream');
  await waitFor(() => expect(document.querySelector('[data-attachment="big.bin"][data-attachment-state=failed] > div')?.getAttribute('title')).toMatch(/Larger than 50 MiB/));
  await h.limit(1); upload('two.bin', new Uint8Array(2 * 1024 * 1024).fill(2), 'application/octet-stream');
  await waitFor(() => expect(document.querySelector('[data-attachment="two.bin"][data-attachment-state=failed] > div')?.getAttribute('title')).toMatch(/Larger than 1 MiB/));
});
