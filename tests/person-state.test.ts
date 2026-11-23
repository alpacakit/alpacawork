import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPersonSettings, createNoticeState } from '@alpacawork/backend/test-dist/receiver/person-state.js';
import { FileWriter } from '@alpacawork/backend/test-dist/raw/storage.js';
import { morningUntil, personalSettings, type SettingDefinition } from '@alpacawork/contract';

function synthetic(run: (root: string) => Promise<void>) {
  return async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'person-')));
    try { await run(root); } finally { rmSync(root, { recursive: true, force: true }); }
  };
}
test('personal settings initialize once, save with CAS, and reject invalid or corrupt input', synthetic(async (root) => {
  const settings = createPersonSettings(root);
  await settings.initializeLanguage('ja-JP,ja;q=0.9,en;q=0.8');
  const first = settings.get();
  assert.equal(first.values.language, 'ja');
  assert.equal(first.values['depth.desktop'], undefined);
  assert.equal(first.values['depth.mobile'], undefined);
  assert.equal(await settings.initializeLanguage('en-US'), null);
  assert.deepEqual(settings.get(), first);
  const changed = await settings.set('theme', 'dark', first.revision);
  assert.equal(changed.values.theme, 'dark');
  await assert.rejects(settings.set('push.done', true, first.revision), { status: 409 });
  await assert.rejects(settings.set('theme', 'purple', changed.revision), { status: 400 });
  await assert.rejects(settings.set('unknown', true, changed.revision), { status: 400 });
  assert.equal((await settings.get()).revision, changed.revision);
  const concurrent = await Promise.allSettled([
    settings.set('push.done', true, changed.revision), settings.set('theme', 'light', changed.revision),
  ]);
  assert.equal(concurrent.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(concurrent.filter((result) => result.status === 'rejected').length, 1);
  const current = await settings.get();
  await assert.rejects(settings.set('depth.mobile', '4', current.revision), { status: 400 });
  await assert.rejects(settings.set('depth.desktop', 'all', current.revision), { status: 400 });
  const path = join(root, '.alpacawork', 'personal-settings.json');
  assert.equal(statSync(path).mode & 0o777, 0o600);
  writeFileSync(path, '{bad');
  assert.throws(() => settings.get(), { status: 503 });
}));

test('a read that names no language saves nothing, so the screen still chooses its language from the browser', synthetic(async (root) => {
  const settings = createPersonSettings(root), path = join(root, '.alpacawork', 'personal-settings.json');
  const read = settings.get();
  assert.equal(read.values.language, 'en');
  assert.equal(existsSync(path), false);
  assert.equal(settings.get().revision, read.revision);
  assert.equal(await settings.initializeLanguage('*'), null);
  assert.equal(existsSync(path), false);
  // A save before the screen ever opened starts from that read's revision, and leaves the screen's language open.
  await assert.rejects(settings.set('theme', 'dark', 'stale'), { status: 409 });
  const saved = await settings.set('ai.language', 'fr-CA', (await settings.get()).revision);
  await settings.initializeLanguage('ja-JP,ja;q=0.9');
  const opened = settings.get();
  assert.equal(opened.values.language, 'ja');
  assert.equal(opened.values['ai.language'], 'fr-CA');
  assert.notEqual(opened.revision, saved.revision);
}));

test('a stored reply language is read in its canonical form, and one that is no tag leaves only itself unset', synthetic(async (root) => {
  const path = join(root, '.alpacawork', 'personal-settings.json');
  await createPersonSettings(root).initializeLanguage('en');
  const write = (tag: string) => writeFileSync(path, JSON.stringify({ version: 1, revision: 'r', value: { language: 'ja', 'ai.language': tag } }));
  write('ja-jp');
  assert.equal(createPersonSettings(root).values()['ai.language'], 'ja-JP');
  write('not a tag!');
  const values = createPersonSettings(root).values();
  assert.equal(values['ai.language'], null);
  assert.equal(values.language, 'ja');
}));

for (const invalid of [null, [], 'invalid', { theme: 'purple' }, { 'push.mutedUntil': 'broken' }])
  test(`corrupt current preferences are refused: ${JSON.stringify(invalid)}`, synthetic(async root => {
    await createPersonSettings(root).get();
    const path = join(root, '.alpacawork', 'personal-settings.json');
    const file = JSON.stringify({ version: 1, revision: 'fixture', value: invalid });
    writeFileSync(path, file);
    const settings = createPersonSettings(root);
    assert.throws(() => settings.get(), { status: 503 });
    assert.throws(() => settings.values(), { status: 503 });
    await assert.rejects(settings.set('theme', 'light', 'fixture'), { status: 503 });
    assert.equal(readFileSync(path, 'utf8'), file, 'invalid settings must not be overwritten');
  }));

test('presence settings validate choices, time zones, and a nullable manual pause', synthetic(async root => {
  const settings = createPersonSettings(root);
  let current = await settings.get();
  assert.equal(current.values['push.awayAfter'], '5');
  assert.equal(current.values['push.mutedUntil'], null);
  current = await settings.set('push.awayAfter', '2', current.revision, 'Asia/Tokyo');
  assert.equal(current.values['push.timeZone'], 'Asia/Tokyo');
  current = await settings.set('push.quietFrom', '21:30', current.revision);
  const hourStart = Date.now();
  current = await settings.pause('hour', 'Asia/Tokyo');
  assert.ok(Date.parse(String(current.values['push.mutedUntil'])) >= hourStart + 60 * 60_000);
  assert.ok(Date.parse(String(current.values['push.mutedUntil'])) <= Date.now() + 60 * 60_000);
  const twoHoursStart = Date.now();
  current = await settings.pause('two-hours', 'Asia/Tokyo');
  assert.ok(Date.parse(String(current.values['push.mutedUntil'])) >= twoHoursStart + 2 * 60 * 60_000);
  assert.ok(Date.parse(String(current.values['push.mutedUntil'])) <= Date.now() + 2 * 60 * 60_000);
  const morningStart = Date.now();
  current = await settings.pause('morning', 'Asia/Tokyo');
  const morningEnd = Date.now();
  assert.ok([morningUntil(morningStart, current.values), morningUntil(morningEnd, current.values)]
    .includes(Date.parse(String(current.values['push.mutedUntil']))));
  current = await settings.resume();
  assert.equal(current.values['push.mutedUntil'], null);
  await assert.rejects(settings.set('push.mutedUntil', '2026-10-14T22:00:00.000Z', current.revision), { status: 400 });
  await assert.rejects(settings.set('push.mutedUntil', 'hour', current.revision), { status: 400 });
  await assert.rejects(settings.set('push.mutedUntil', null, current.revision), { status: 400 });
  await assert.rejects(settings.set('push.quietResumedUntil', '2099-01-01T00:00:00.000Z', current.revision), { status: 400 });
  await assert.rejects(settings.set('push.quietResumedUntil', null, current.revision), { status: 400 });
  assert.equal((await settings.get()).revision, current.revision);
  await assert.rejects(settings.set('push.awayAfter', '3', current.revision), { status: 400 });
  await assert.rejects(settings.set('push.quietTo', '08:15', current.revision), { status: 400 });
  await assert.rejects(settings.set('push.quiet', true, current.revision, 'Nowhere/Invalid'), { status: 400 });
}));

test('one extra registration enables default, validation and saving without a keyed route', synthetic(async (root) => {
  const definitions: readonly SettingDefinition[] = [...personalSettings,
    { key: 'testExtra', group: 'display', owner: 'person', kind: 'toggle', defaultValue: false,
      labelKey: 'settings.personal.pushDone' }];
  await createPersonSettings(root).initializeLanguage('en-US');
  const settings = createPersonSettings(root, definitions);
  const first = settings.get();
  assert.equal(first.values.testExtra, false);
  const saved = await settings.set('testExtra', true, first.revision);
  assert.equal((await settings.get()).values.testExtra, true);
  await assert.rejects(settings.set('testExtra', 'yes', saved.revision), { status: 400 });
}));

test('notice checkpoint and reads are separate from settings and require current revision', synthetic(async (root) => {
  const notices = createNoticeState(root);
  assert.deepEqual(await notices.get(), { state: null, revision: null });
  const baseline = { log: 1, state: 'todo' as const, body: '0123abcd', turnKey: null };
  const state = { version: 4 as const, checkpoint: { at: '2026-10-02T00:00:00.000Z', tasks: { T1: baseline } },
    reads: { T2: baseline } };
  const first = await notices.save(state, null);
  await assert.rejects(notices.save(state, null), { status: 409 });
  assert.equal((await notices.get()).revision, first.revision);
  assert.equal(statSync(join(root, '.alpacawork', 'notice-state.json')).mode & 0o777, 0o600);
  assert.equal(readFileSync(join(root, '.alpacawork', 'notice-state.json'), 'utf8').includes('checkpoint'), true);
  await assert.rejects(notices.save({ ...state, checkpoint: { at: 'invalid', tasks: {} } }, first.revision));
  assert.equal((await notices.get()).revision, first.revision);
  writeFileSync(join(root, '.alpacawork', 'notice-state.json'), '{bad');
  await assert.rejects(notices.get(), { status: 503 });
}));

test('existing person files can be read while the RAW write lock is held', synthetic(async (root) => {
  const settings = createPersonSettings(root), notices = createNoticeState(root);
  await settings.initializeLanguage('en');
  await notices.save({ version: 4, checkpoint: { at: '2026-10-02T00:00:00.000Z', tasks: {} }, reads: {} }, null);
  const writer = new FileWriter(root);
  try {
    await writer.locked(async () => {
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          Promise.all([settings.get(), notices.get()]),
          new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error('person read waited for RAW lock')), 500); }),
        ]);
        assert.ok(result[0].revision);
        assert.ok(result[1].revision);
      } finally { clearTimeout(deadline); }
    });
  } finally { writer.close(); }
}));

// Each clock's next end: presence.test.ts › morning pause chooses the next 11:00.
test('morning pause persists the next quiet end', synthetic(async root => {
  const settings = createPersonSettings(root);
  let current = await settings.get();
  current = await settings.set('push.quiet', true, current.revision, 'Asia/Tokyo');
  current = await settings.set('push.quietTo', '11:00', current.revision);
  const original = Date.now;
  Date.now = () => Date.parse('2026-10-16T23:30:00+09:00');
  try {
    const paused = await settings.pause('morning', 'Asia/Tokyo');
    const expected = new Date('2026-10-17T11:00:00+09:00').toISOString();
    assert.equal(paused.values['push.mutedUntil'], expected);
    assert.equal(createPersonSettings(root).values()['push.mutedUntil'], expected);
  } finally { Date.now = original; }
}));
