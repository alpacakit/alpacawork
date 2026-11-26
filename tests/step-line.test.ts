/** A step's one line leaves off only a plain leading `cd <dir> &&` or `;` that changes nothing about what it says. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commandLine } from '../apps/web/src/domain/step-line.ts';

test('a plain cd to a bare directory is left off before a plain command', () => {
  assert.equal(commandLine('cd /home/user/project && rg -n total src'), 'rg -n total src');
  assert.equal(commandLine('cd /tmp; git log --oneline -5'), 'git log --oneline -5');
  assert.equal(commandLine('cd ~/work/app-1 &&  pnpm test | tail -5'), 'pnpm test | tail -5');
});

test('any other start is kept as written', () => {
  for (const text of ['cd "/my dir" && ls', "cd '/tmp' && ls", 'cd $HOME && ls', 'cd /a\\ b && ls', 'cd /tmp && ', 'cd /tmp',
    'cd /tmp || exit 1', 'cd -P /tmp && ls', 'cd /tmp/* && ls', 'cd $(git rev-parse --show-toplevel) && ls', 'echo cd /tmp && ls',
    'cd /tmp && && ls', 'git status --short',
    // The line goes on to the next, or is only a comment: what runs is not on it.
    'cd /tmp && \\', 'cd /tmp && # build the docs',
    // Whether cd worked decides what runs.
    'cd /missing && printf SKIPPED || printf FALLBACK', 'cd /tmp && (make || true)'])
    assert.equal(commandLine(text), text, text);
});
