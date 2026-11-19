import { fixtureAgentSetting, installAgentStub } from '../tests/helpers/agent-stub.ts';
import { parse, stringify } from 'yaml';
import { revealReplies } from './coordinator-fixture.ts';
import { coordinatorMessage, coordinatorCompleted } from './coordinator-completion.ts';
import { join } from 'node:path';
import { test, expect, open, openCoordinator } from './fixtures.ts';
import { writeFixtureConfig } from './fixture-writes.ts';
import { controlledNavigation } from './service-worker-lifecycle.ts';

// Another app shares pictures to the installed app (manifest share_target): the browser posts them to /share, the
// Service Worker keeps them and opens the screen, and the coordinator's input opens with them attached. Nothing is sent.
// The post comes from a page outside the app, as a share from Android does, so it is a navigation the worker answers.
const fake = new URL('../tests/fixtures/fake-coordinator-agent.mjs', import.meta.url).pathname;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==', 'base64');
const SHOTS = process.env.SHARE_TARGET_SHOTS;

test.use({ isolated: true, serviceWorkers: 'allow' });
const fakeCoordinator = (runtime: { root: string }, limits = '') => {
  installAgentStub(runtime.root, 'claude', [process.execPath, fake]);
  const setting = fixtureAgentSetting('claude');
  setting.params.model = [];
  setting.params.effort = [];
  writeFixtureConfig(runtime.root, stringify({ ...parse(limits), agents: { fake: setting } }));
};

// Android hands the app only the files its manifest accepts (Chromium's MimeTypeFilter: `*/*`, `type/*`, a type or an
// `.extension`), so the post here keeps to the same rule, read from the served manifest.
const accepts = (accept: string[], name: string, type: string) => accept.some(each => each === '*/*' || each === type
  || each.endsWith('/*') && type.startsWith(each.slice(0, -1)) || each.startsWith('.') && name.toLowerCase().endsWith(each));

test('files of any kind shared together are all attached; one too large to attach is named in the input and the rest are sent', async ({ page, runtime }) => {
  test.setTimeout(120_000);
  // The input refuses by the workspace's limit, which the worker cannot read: 1 MiB here.
  fakeCoordinator(runtime, 'limits: {attachment_mib: 1}\n');
  await page.setViewportSize({ width: 412, height: 915 });
  await open(page, runtime);
  await controlledNavigation(page);
  const manifest = await (await page.request.get(`${runtime.origin}/manifest.webmanifest`)).json() as
    { share_target: { params: { files: { name: string; accept: string[] }[] } } };
  const accept = manifest.share_target.params.files[0]!.accept;
  const shared = [
    { name: 'photo.png', mimeType: 'image/png', buffer: PNG },
    // Some apps share a file named without its extension.
    { name: 'document', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n%%EOF\n') },
    { name: 'clip.mp4', mimeType: 'video/mp4', buffer: Buffer.alloc(2048, 1) },
    { name: 'voice.m4a', mimeType: 'audio/mp4', buffer: Buffer.alloc(1024, 2) },
    { name: 'big.zip', mimeType: 'application/zip', buffer: Buffer.alloc(1024 * 1024 + 1, 3) },
  ].filter(file => accepts(accept, file.name, file.mimeType));

  await page.goto('about:blank');
  await page.setContent(`<form method="post" enctype="multipart/form-data" action="${runtime.origin}/share">
    <input name="title" value=""><input name="text" value=""><input name="url" value="">
    <input type="file" name="files" multiple></form>`);
  await page.locator('input[type=file]').setInputFiles(shared);
  const landed = page.waitForURL(`${runtime.origin}/`);
  await page.locator('form').evaluate(form => (form as HTMLFormElement).submit());
  await landed;

  const card = page.locator('[data-coordinator-card]');
  await expect(card).toBeVisible();
  if (await page.getByRole('button', { name: 'Reconnect' }).isVisible())
    await page.getByRole('button', { name: 'Reconnect' }).click();
  await expect(card.locator('[data-attachment-state=saved]')).toHaveCount(4);
  // Each card says what it is: the PDF named by its type, the too large one with why it did not go in.
  await expect(card.locator('[data-attachment="document.pdf"]')).toContainText('PDF');
  await expect(card.locator('[data-attachment="voice.m4a"]')).toContainText('M4A');
  await expect(card.locator('[data-attachment="big.zip"][data-attachment-state=failed] > div')).toHaveAttribute('title', /Larger than 1 MiB/);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'any-file.png') });
  // Sending waits until the file that did not go in is taken out by hand.
  const send = card.locator('[data-ask-send]');
  await expect(send).toBeDisabled();
  await card.getByRole('button', { name: 'Remove big.zip' }).click();
  await expect(card.locator('[data-attachment]')).toHaveCount(4);
  const sent = coordinatorMessage(page);
  await send.click();
  await coordinatorCompleted(page, runtime, await sent);
  // Sent from the input at the screen's foot, it goes down to its line; the way in over it says the answer; opened, the conversation shows it.
  await expect(page.locator('[data-coordinator-pill] [data-coordinator-unseen]')).toBeVisible(); await openCoordinator(page);
  // The latest reply is shown directly; older unread replies have their own row.
  await revealReplies(page);
  await expect(page.locator('[data-coordinator-panel] [data-ask-answer]')).toHaveCount(1);
  const answer = JSON.parse((await page.locator('[data-coordinator-panel] [data-ask-answer]').textContent())!);
  for (const name of ['photo.png', 'document.pdf', 'clip.mp4', 'voice.m4a']) expect(answer.prompt).toContain(name);
  expect(answer.prompt).not.toContain('big.zip');
  expect(answer.imageBytes).toBe(PNG.length);

  // A file the worker could not keep (the device's storage full) is named as not received; the one kept is attached.
  await page.evaluate(async () => {
    const inbox = await caches.open('share-inbox');
    await inbox.put('/share/0', new Response(new Blob(['%PDF-1.4'], { type: 'application/pdf' })));
    await inbox.put('/share/list', Response.json({ at: Date.now(), title: '', text: '', url: '',
      files: [{ name: 'kept.pdf', type: 'application/pdf', size: 8 }, { name: 'lost.mov', type: 'video/quicktime', size: 4096 }] }));
  });
  await page.reload();
  await expect(card.locator('[data-attachment="kept.pdf"][data-attachment-state=saved]')).toBeVisible();
  await expect(card.locator('[data-attachment="lost.mov"][data-attachment-state=failed] > div')).toHaveAttribute('title', /Could not be received/);
  await card.getByRole('button', { name: 'Remove lost.mov' }).click();
  await expect(card.locator('[data-attachment]')).toHaveCount(1);
});
