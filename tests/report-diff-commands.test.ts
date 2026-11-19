import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findDiffCommands } from '@alpacawork/contract/report-diff';

test('report diff grammar: code only, immutable endpoints, literal argv, and insertion after the whole block', () => {
  const cases: [string, string | null, string?, string?, string[]?][] = [
    ['git diff a..b', 'compare', 'a', 'b'], ['git diff a...b', 'compare', 'a', 'b'],
    ['git diff ..b', 'compare', 'HEAD', 'b'], ['git diff a..', 'compare', 'a', 'HEAD'],
    ['git diff a b', 'compare', 'a', 'b'], ['git diff a^!', 'compare', 'a^', 'a'],
    ['git diff HEAD README.md', 'compare', 'HEAD', 'README.md'], // Candidate pair; Git resolution decides whether the second word is a path.
    ['git -C /repo -C sub -c diff.external=unsafe --no-pager diff --stat a..b -- "a b.md"', 'compare', 'a', 'b', ['a b.md']],
    ['git diff --output /tmp/never a..b | touch /tmp/never', 'compare', 'a', 'b'],
    ['git diff a..b 2>/tmp/never', 'compare', 'a', 'b', []],
    ['git diff a..b -- --strange.md', 'compare', 'a', 'b', ['--strange.md']],
    ['git diff', 'unsupported'], ['git diff main', 'unsupported'], ['git diff a b c', 'unsupported'],
    ...['--cached', '--staged', '--no-index', '--merge-base'].map(option => [`git diff ${option} a..b`, 'unsupported'] as [string, string]),
    ['git --git-dir=/elsewhere diff a..b', 'unsupported'], ['git --work-tree=/elsewhere diff a..b', 'unsupported'],
    ['git diff $BASE..b', 'invalid'], ['git -C ~/repo diff a..b', 'invalid'], ['git diff -bad..b', 'invalid'],
    ['git diff "a..b', 'invalid'], ['echo git diff a..b', null],
  ];
  for (const [command, kind, base, head, paths] of cases) {
    const found = findDiffCommands(`
\`\`\`sh
${command}
\`\`\`
`);
    if (kind === null) { assert.deepEqual(found, [], command); continue; }
    assert.equal(found[0]?.kind, kind, command);
    if (found[0]?.kind === 'compare') {
      assert.equal(found[0].base, base, command); assert.equal(found[0].head, head, command);
      if (paths) assert.deepEqual(found[0].paths, paths, command);
    }
  }
  assert.deepEqual(findDiffCommands('git diff a..b is an example'), []);
  const list = '- first `git diff a..b`\n- second\n\nafter';
  assert.equal(findDiffCommands(list)[0]?.after, list.indexOf('\n\n') + 1);
  const continued = '```console\r\n$ git -C /repo diff \\\r\n a..b -- "a b"\r\n```\r\nrest';
  const found = findDiffCommands(continued)[0];
  assert.equal(found?.kind, 'compare');
  if (found?.kind === 'compare') assert.deepEqual(found.paths, ['a b']);
  assert.equal(found?.after, continued.indexOf('rest'));
  assert.equal(findDiffCommands('```sh\ngit diff a..b')[0]?.kind, 'invalid');
});
