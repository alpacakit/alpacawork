import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import { allowFixtureWrites } from './read-fixtures';
import { uploadAttachment } from '../src/data/attachments';
import { useConnection } from '../src/data/connection';
import { queryClient } from '../src/data/query-client';
import { receiveFullIndex } from '../src/data/resources';
import type { ProjectedIndexDTO } from '@alpacawork/contract/control';

beforeEach(allowFixtureWrites);
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
const destination = { kind: 'coordinator', conversationId: 'conversation' } as const;
function transport() {
  const send = vi.fn();
  class Xhr {
    upload = {};
    status = 200;
    responseText = JSON.stringify({ path: 'attachments/request/photo.png', absolutePath: '/api/coordinator/file?requestId=request&name=photo.png', size: 5 });
    onload?: () => void;
    open() {}
    setRequestHeader() {}
    send(file: File) { send(file); this.onload?.(); }
  }
  vi.stubGlobal('XMLHttpRequest', Xhr);
  return send;
}
const upload = (signal = new AbortController().signal) => uploadAttachment(destination, 'request', new File(['image'], 'photo.png'), 'photo.png', () => {}, signal, 'operation');

test('a selected file waits for live write authority and is transmitted exactly once', async () => {
  const send = transport();
  useConnection.setState({ offline: true, state: 'connecting' });
  const result = upload();
  expect(send).not.toHaveBeenCalled();
  useConnection.setState({ offline: false, state: 'live' });
  await expect(result).resolves.toMatchObject({ name: 'photo.png', size: 5 });
  useConnection.setState({ lastReceivedAt: Date.now() });
  expect(send).toHaveBeenCalledTimes(1);
});

test('a foreground check that revokes writes does not transmit the retained file', async () => {
  const send = transport();
  useConnection.setState({ offline: true, state: 'connecting' });
  const result = upload();
  useConnection.setState({ offline: false, state: 'live', writable: false });
  await expect(result).rejects.toMatchObject({ code: 'forbidden' });
  expect(send).not.toHaveBeenCalled();
});

for (const changed of [{ root: '/another-workspace' }, { generation: 'another-generation' }]) test(`a pending upload cannot move to ${Object.keys(changed)[0]}`, async () => {
  const send = transport();
  useConnection.setState({ offline: true, state: 'connecting' });
  const result = upload();
  const index = queryClient.getQueryData<ProjectedIndexDTO>(['index'])!;
  receiveFullIndex(queryClient, { ...index, ...changed });
  useConnection.setState({ offline: false, state: 'live' });
  await expect(result).rejects.toMatchObject({ code: 'conflict' });
  expect(send).not.toHaveBeenCalled();
});

test('cancelling while waiting never transmits after reconnection', async () => {
  const send = transport(), controller = new AbortController();
  useConnection.setState({ offline: true, state: 'connecting' });
  const result = upload(controller.signal);
  controller.abort();
  await expect(result).rejects.toMatchObject({ name: 'AbortError' });
  useConnection.setState({ offline: false, state: 'live' });
  expect(send).not.toHaveBeenCalled();
});

test('a connection check has a bounded wait and a late reconnection sends no bytes', async () => {
  vi.useFakeTimers();
  const send = transport();
  useConnection.setState({ offline: true, state: 'connecting' });
  const result = upload();
  const refused = expect(result).rejects.toMatchObject({ code: 'write_unavailable', retry: 'later' });
  await vi.advanceTimersByTimeAsync(20_000);
  await refused;
  useConnection.setState({ offline: false, state: 'live' });
  expect(send).not.toHaveBeenCalled();
});

// Admission belongs to the click; the transport can only continue its frozen identity.
test('an admitted removal still sends its original pin when storage becomes full', async () => {
  const { admitAttachmentRemoval, removeAttachment } = await import('../src/data/attachments');
  const id = admitAttachmentRemoval(destination), before = sessionStorage.getItem('alpacawork-write-identity:' + JSON.stringify(['/fixture', id]));
  expect(before).not.toBeNull();
  const writes = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Full', 'QuotaExceededError'); });
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
  await removeAttachment(destination, 'request', 'photo.png', id);
  expect(fetcher).toHaveBeenCalledTimes(1); expect(writes).not.toHaveBeenCalled();
  const [, request] = fetcher.mock.calls[0]!;
  expect(request?.method).toBe('DELETE'); expect(new Headers(request?.headers).get('X-Alpacawork-Op-Id')).toBe(id);
  expect(new Headers(request?.headers).get('X-Alpacawork-Restore-Id')).toBe('initial');
  expect(sessionStorage.getItem('alpacawork-write-identity:' + JSON.stringify(['/fixture', id]))).toBe(before);
});

for (const raw of [null, '{bad', '{"restoreId":null}', '{"restoreId":"unsupported"}', '{"restoreId":"initial","extra":true}']) test(`removal without valid admission ${raw} sends nothing and preserves its evidence`, async () => {
  const { removeAttachment } = await import('../src/data/attachments');
  const id = crypto.randomUUID(), key = 'alpacawork-write-identity:' + JSON.stringify(['/fixture', id]);
  if (raw !== null) sessionStorage.setItem(key, raw);
  const writes = vi.spyOn(Storage.prototype, 'setItem'), fetcher = vi.spyOn(globalThis, 'fetch');
  await expect(removeAttachment(destination, 'request', 'photo.png', id)).rejects.toMatchObject({ code: raw === null || raw === '{"restoreId":null}' ? 'restore_changed' : 'write_unavailable' });
  expect(fetcher).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled(); expect(sessionStorage.getItem(key)).toBe(raw);
});

test('a removal admitted before restore retains its old pin for the server refusal', async () => {
  const { admitAttachmentRemoval, removeAttachment } = await import('../src/data/attachments');
  const id = admitAttachmentRemoval(destination), index = queryClient.getQueryData<ProjectedIndexDTO>(['index'])!;
  receiveFullIndex(queryClient, { ...index, restoreId: '1f347e6d-caba-4994-aa45-a9cf99182996' });
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: { code: 'restore_changed', message: 'Restored', retry: 'fix' } }), { status: 409 }));
  const writes = vi.spyOn(Storage.prototype, 'setItem');
  await expect(removeAttachment(destination, 'request', 'photo.png', id)).rejects.toMatchObject({ code: 'restore_changed' });
  expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get('X-Alpacawork-Restore-Id')).toBe('initial');
  expect(writes).not.toHaveBeenCalled();
});
