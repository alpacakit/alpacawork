import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { skillsLatestResponseSchema, skillsResponseSchema } from '@alpacawork/contract';
import { InstalledSkillsStore } from '@alpacawork/core/installed-skills';
import { FirstRunSkills } from '@alpacawork/backend/test-dist/installation/first-run-skills.js';

const first = { sha: 'a'.repeat(40), date: '2026-10-01T12:00:00Z' };
const next = { sha: 'b'.repeat(40), date: '2026-11-01T12:00:00Z' };
const commits = (revision: typeof first) => Response.json([{ sha: revision.sha, commit: { committer: { date: revision.date } } }]);

function fixture(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), 'repository-skill-versions-'));
  const root = join(home, '.agents', 'skills');
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return { home, root, env: { HOME: home, PATH: '' }, release: home };
}

async function finished(service: FirstRunSkills) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const status = skillsResponseSchema.parse(await service.status());
    if (status.job?.finished) return status;
    await delay(5);
  }
  throw new Error('Skill job did not finish');
}

test('latest checks GitHub skill paths only and caches readable and unavailable dates', async t => {
  const f = fixture(t);
  const paths: string[] = [];
  const service = new FirstRunSkills({ ...f, fetchCommit: async input => {
    const url = new URL(String(input));
    assert.equal(url.origin + url.pathname, 'https://api.github.com/repos/alpacakit/pocket-skills/commits');
    assert.equal(url.searchParams.get('per_page'), '1');
    const path = url.searchParams.get('path')!;
    paths.push(path);
    return path === 'skills/askmeclearly' ? commits(first) : new Response(null, { status: 403 });
  } });
  t.after(() => service.close());

  assert.ok((await service.status()).skills.every(skill => skill.installedAt === null));
  assert.deepEqual(paths, []);
  const reads = await Promise.all([service.latest(), service.latest()]);
  assert.deepEqual(reads.map(read => skillsLatestResponseSchema.parse(read).skills), Array.from({ length: 2 }, () => [
    { name: 'askmeclearly', latestAt: first.date }, { name: 'doyourjob', latestAt: null },
  ]));
  assert.deepEqual(paths.sort(), ['skills/askmeclearly', 'skills/doyourjob']);
  const later = Date.now() + 10 * 60_000 + 1;
  t.mock.method(Date, 'now', () => later);
  await service.latest();
  assert.equal(paths.length, 4);
});

test('reinstall records the freshly installed GitHub revision without changing the bundled receipt', async t => {
  const f = fixture(t);
  const remote = join(f.root, 'doyourjob', 'SKILL.md'), bundled = join(f.root, 'alpacawork-betterquality', 'SKILL.md');
  mkdirSync(join(f.root, 'doyourjob'), { recursive: true });
  mkdirSync(join(f.root, 'alpacawork-betterquality'));
  writeFileSync(remote, 'existing');
  writeFileSync(bundled, 'bundled');
  writeFileSync(join(f.release, 'package.json'), '{"version":"0.1.0"}');
  const store = new InstalledSkillsStore(f.root);
  const receipt = await store.session(session => {
    session.begin({ operationId: randomUUID(), release: f.release, place: ['alpacawork', 'alpacawork-betterquality'], remove: [] });
    return session.commit();
  });

  let revision: typeof first | null = first;
  const sources: string[] = [];
  const service = new FirstRunSkills({ ...f, fetchCommit: async () => {
    if (revision === null) throw new Error('GitHub unavailable');
    return commits(revision);
  }, run: async (_command, args) => {
    assert.equal(args[args.indexOf('--skill') + 1], 'doyourjob');
    sources.push(args[3]!);
    writeFileSync(remote, revision?.sha ?? 'unversioned');
    return '';
  } });
  t.after(() => service.close());
  const install = async () => {
    service.install({ names: ['doyourjob', 'alpacawork-betterquality'] });
    const status = await finished(service);
    assert.deepEqual(status.job?.items.map(item => item.state), ['done', 'done']);
    assert.equal(status.skills.find(skill => skill.name === 'alpacawork-betterquality')?.installedAt, null);
    return status.skills.find(skill => skill.name === 'doyourjob')?.installedAt;
  };

  assert.equal((await service.status()).skills.find(skill => skill.name === 'doyourjob')?.installedAt, null);
  assert.equal(await install(), first.date);
  revision = next;
  assert.equal(await install(), next.date);
  assert.equal(readFileSync(remote, 'utf8'), next.sha);
  const restarted = new FirstRunSkills(f);
  assert.equal((await restarted.status()).skills.find(skill => skill.name === 'doyourjob')?.installedAt, next.date);

  revision = null;
  assert.equal(await install(), null);
  assert.deepEqual(sources, [first, next, null].map(value => 'https://github.com/alpacakit/pocket-skills.git' + (value ? `#${value.sha}` : '')));
  assert.equal(readFileSync(bundled, 'utf8'), 'bundled');
  assert.deepEqual(store.read()?.receipt, receipt);
});
