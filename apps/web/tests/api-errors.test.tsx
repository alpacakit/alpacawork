import { beforeEach as beforeSendCase } from 'vitest';
import { allowFixtureWrites } from './read-fixtures';
beforeSendCase(allowFixtureWrites);
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { i18n, startI18n } from "@alpacawork/i18n";
import { z } from "zod";
import { apiError, ApiError, createApi, errorText } from "../src/data/client";
import { describeProblem, issueText } from "../src/features/forms/problem-text";
import { readCoordinator } from "../src/data/coordinator";
import { admitAttachmentRemoval, removeAttachment, uploadAttachment, type AttachmentDestination } from "../src/data/attachments";
import { workspaceWriteBasis } from '../src/data/connection';
import { problemText } from '../src/features/forms/problem-text';

beforeAll(() => startI18n());
afterEach(() => { vi.unstubAllGlobals(); });
const diagnostic = "SERVER DIAGNOSTIC MUST NOT APPEAR";
const refusal = { code: "question_closed" as const, retry: "reread" as const, message: diagnostic,
  detail: { question: "L1" }, issues: [{ path: "title", code: "blank", message: diagnostic }] };

for (const language of ['ja', 'en']) for (const method of ['GET', 'POST'])
  for (const body of ['empty', 'html', 'object', 'origin'] as const)
    test(`403 ${body} ${method} ${language} states refusal and preserves retry and structured reason`, async () => {
      await i18n.changeLanguage(language);
      const reason = { kind: 'cross_origin_request_rejected' as const };
      const text = body === 'empty' ? '' : body === 'html' ? '<html>Forbidden</html>' : body === 'object' ? '{}'
        : JSON.stringify({ error: { code: 'forbidden', message: diagnostic, retry: 'fix', reason } });
      const fetcher = vi.fn(async () => new Response(text, { status: 403 }));
      vi.stubGlobal('fetch', fetcher);
      const error = await createApi().request('test', z.object({}), undefined,
        method === 'POST' ? {} : undefined, 'kept-op-id', workspaceWriteBasis()).catch(error => error);
      expect(error).toBeInstanceOf(ApiError);
      const title = language === 'ja' ? 'この操作を行う権限がありません。' : 'You do not have permission for this operation.';
      const detail = body !== 'origin' ? '' : language === 'ja' ? '別オリジンからの要求は受け付けられません' : 'Requests from another origin are not accepted';
      const retry = body === 'origin' ? 'fix' : method === 'GET' ? 'later' : 'check';
      expect(error.code).toBe('forbidden'); expect(error.retry).toBe(retry);
      expect(error.reason).toEqual(body === 'origin' ? reason : undefined);
      expect(describeProblem(error)).toEqual({ title, detail, refusal: retry !== 'check' });
      expect(problemText(error)).toBe(detail ? `${title} ${detail}` : title);
      const sent = fetcher.mock.calls as unknown as [string, RequestInit][];
      expect(sent).toHaveLength(1); expect(sent[0]![1].method).toBe(method);
      if (method === 'POST') expect(new Headers(sent[0]![1].headers).get('X-Alpacawork-Op-Id')).toBe('kept-op-id');
    });

test("all HTTP adapters keep machine refusal facts and translate diagnostics at the display boundary", async () => {
  await i18n.changeLanguage("ja");
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: refusal }, { status: 409 })));
  const destination: AttachmentDestination = { kind: "task", taskId: "T1" };
  for (const operation of [() => createApi().request("test", z.object({})), readCoordinator,
    () => removeAttachment(destination, "r", "f", admitAttachmentRemoval(destination))]) {
    const error = await operation().catch(error => error);
    expect(error).toBeInstanceOf(ApiError);
    expect(errorText(error)).toBe("問いはすでに閉じています");
    expect(describeProblem(error)).toEqual({ title: "問いはすでに閉じています", detail: "", refusal: true });
    expect(error.detail).toEqual(refusal.detail);
    expect(error.issues).toEqual(refusal.issues);
    expect(error.retry).toBe("reread");
    expect(error.message).toBe(diagnostic);
  }
  class Upload {
    status = 409; responseText = JSON.stringify({ error: refusal }); upload = {};
    onload?: () => void; open() {} setRequestHeader() {} abort() {} send() { this.onload?.(); }
  }
  vi.stubGlobal("XMLHttpRequest", Upload);
  const error = await uploadAttachment(destination, "r", new File(["x"], "f"), "f", () => {}, new AbortController().signal, "op").catch(error => error);
  expect(errorText(error)).toBe("問いはすでに閉じています");
  expect(error.detail).toEqual(refusal.detail);
  expect(error.issues).toEqual(refusal.issues);
});

test("the Japanese error words are preserved exactly and never selected from diagnostic prose", async () => {
  await i18n.changeLanguage("ja");
  for (const [code, text] of [
    ["voice_too_large", "音声は16 MiBまでです"], ["voice_empty", "録音した音声がありません"],
    ["voice_recognition_failed", "ローカル音声認識に失敗しました (503)"],
    ["urgent_to_user", "依頼元が利用者のときは緊急にできない。問いで聞く"],
    ["question_expired", "問いはタスクの中止で失効しています"], ["question_closed", "問いはすでに閉じています"],
    ["question_stopped", "中止したタスクからは問えない"],
  ]) expect(errorText(new ApiError(diagnostic, code, "fix", { status: 503 }))).toBe(text);
  expect(describeProblem(new ApiError(diagnostic, "voice_recognition_failed", "check", { status: 502 })))
    .toEqual({ title: "ローカル音声認識に失敗しました (502)", detail: "", refusal: false });
  const error = apiError({ code: "voice_empty", message: diagnostic, retry: "fix" });
  await i18n.changeLanguage("en");
  expect(errorText(error)).toBe("No recorded audio was provided");
  await i18n.changeLanguage("ja");
  expect(errorText(error)).toBe("録音した音声がありません");
  expect(errorText(new ApiError(diagnostic, "new_unknown_code"))).not.toContain(diagnostic);
  expect(errorText(new Error(diagnostic))).not.toContain(diagnostic);
  expect(issueText({ code: "unknown", path: "x", message: diagnostic })).toBe("形式を確認してください。");
});

test('specific failure reasons retain the old English information and translate their parameters in Japanese', async () => {
  const examples = [
    [{ kind: 'database_busy' }, 'The database is busy. Wait a moment and try again'],
    [{ kind: 'scope_lookup_unavailable' }, 'Could not read the view scope'],
    [{ kind: 'history_past_unavailable' }, 'Could not read earlier History'],
    [{ kind: 'history_revalidation_unavailable' }, 'Could not reload the latest information'],
    [{ kind: 'voice_key_missing', env: 'MISSING_FAKE_VOICE_KEY' }, 'MISSING_FAKE_VOICE_KEY is not set'],
    [{ kind: 'voice_token_request_failed', provider: 'soniox', status: 502 }, 'Could not get a soniox token (502)'],
    [{ kind: 'voice_token_response_invalid', provider: 'deepgram' }, 'The deepgram token response has an invalid format'],
  ] satisfies [import('@alpacawork/contract/problem').ProblemReason, string][];
  for (const [reason, en] of examples) {
    const error = apiError({ code: 'unavailable', retry: 'check', message: diagnostic, reason });
    await i18n.changeLanguage('en'); expect(errorText(error)).toBe(en);
    await i18n.changeLanguage('ja');
    const japanese = errorText(error);
    expect(japanese, reason.kind).not.toBe(en); expect(japanese, reason.kind).not.toContain(diagnostic); expect(japanese, reason.kind).not.toMatch(/^problem\./);
    for (const [field, fact] of Object.entries(reason)) if (field !== 'kind') expect(japanese, reason.kind).toContain(String(fact));
    expect(error.message).toBe(diagnostic);
  }
});

test('read context supplies a precise fallback and preserves a more specific server reason through every HTTP adapter', async () => {
  const { readWithReason } = await import('../src/data/client');
  await i18n.changeLanguage('en');
  const failure = { ...refusal, reason: { kind: 'voice_key_missing' as const, env: 'KEEP_THIS_KEY' } };
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: failure }, { status: 409 })));
  const destination: AttachmentDestination = { kind: 'task', taskId: 'T1' };
  for (const operation of [() => createApi().request('test', z.object({})), readCoordinator,
    () => removeAttachment(destination, 'r', 'f', admitAttachmentRemoval(destination))]) {
    const error = await readWithReason<unknown>(operation, { kind: 'scope_lookup_unavailable' }).catch(error => error);
    if (!(error instanceof ApiError)) throw error;
    expect(error.reason).toEqual(failure.reason);
    expect(errorText(error)).toBe('KEEP_THIS_KEY is not set');
    expect(error.retry).toBe('reread');
    expect(error.detail).toEqual(refusal.detail);
  }
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: { code: 'io_failure', message: diagnostic, retry: 'later' } }, { status: 503 })));
  const error = await readWithReason(() => createApi().request('test', z.object({})), { kind: 'scope_lookup_unavailable' }).catch(error => error);
  expect(errorText(error)).toBe('Could not read the view scope');
  expect(error.message).toBe(diagnostic);
  expect(error.retry).toBe('later');
});

test('dynamic OS and YAML facts stay separate from translated application wording and technical details', async () => {
  const { problemReasonText } = await import('../src/data/client');
  const reason = { kind: 'host_failure' as const, operation: 'record' as const, cause: {
    kind: 'system_error' as const, code: 'EACCES', syscall: 'open', path: '/tmp/host.sqlite', diagnostic: 'OS supplied diagnostic' } };
  await i18n.changeLanguage('ja');
  const text = problemReasonText(reason);
  for (const fact of ['ホストの記録に失敗しました', 'EACCES', 'open', '/tmp/host.sqlite', '技術的な詳細: OS supplied diagnostic']) expect(text).toContain(fact);
  const yaml = problemReasonText({ kind: 'config_invalid', path: 'config.yaml', issues: [
    { code: 'FLOW_END', line: 3, column: 4, diagnostic: 'parser diagnostic' }] });
  for (const fact of ['config.yaml', '3行4列', 'FLOW_END', '技術的な詳細: parser diagnostic']) expect(yaml).toContain(fact);
  expect(problemReasonText({ kind: 'file_missing', path: 'config.yaml' })).toBe('config.yaml がありません');
});

test('technical causes cannot replace the established Japanese wording of an application refusal', async () => {
  const { Problem, errorBody } = await import('@alpacawork/core');
  await i18n.changeLanguage('ja');
  const cause = Object.assign(new Error('SQLite diagnostic'), { code: 'ERR_SQLITE_ERROR', errcode: 5 });
  expect(errorText(apiError(errorBody(new Problem('question_closed', 'Question already closed', undefined, { cause })).error)))
    .toBe('問いはすでに閉じています');
  const { problemReasonText } = await import('../src/data/client');
  expect(problemReasonText({ kind: 'run_store_unavailable', cause: { kind: 'database_migration_required' } }))
    .toContain('データベース');
});
