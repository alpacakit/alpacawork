import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import config from '../packages/i18n/i18next.config.ts';

const source = new URL('../packages/i18n/', import.meta.url);
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'alpacawork-i18n-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync(new URL('check-filled.ts', source), join(root, 'check-filled.ts'));
  // The copied checker needs only locales, without a dependency on where tmpdir lives.
  writeFileSync(join(root, 'i18next.config.ts'), `export default ${JSON.stringify({ locales: config.locales })};\n`);
  cpSync(new URL('src/locales', source), join(root, 'src/locales'), { recursive: true });
  return { root, check: () => spawnSync(process.execPath, [join(root, 'check-filled.ts')], { encoding: 'utf8' }) };
}

test('every shipped translation catalog is filled', t => {
  const { check } = fixture(t);
  const result = check();
  assert.equal(result.status, 0, result.stderr);
});

test('an empty nested value in any catalog fails the real checker, which names each one', t => {
  const { root, check } = fixture(t);
  const catalogs = config.locales.flatMap(locale => readdirSync(new URL(`src/locales/${locale}/`, source))
    .filter(file => file.endsWith('.json')).map(file => `${locale}/${file}`));
  assert.ok(catalogs.length > 1);
  for (const name of catalogs) {
    const path = join(root, 'src/locales', name);
    const catalog = JSON.parse(readFileSync(path, 'utf8'));
    catalog._checkFilled = { nested: '' };
    writeFileSync(path, JSON.stringify(catalog));
  }
  const result = check();
  assert.equal(result.status, 1, result.stderr);
  for (const name of catalogs) assert.ok(result.stderr.includes(`${name}: empty _checkFilled.nested`), name);
});
