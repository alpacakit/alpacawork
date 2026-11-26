/** A step's one line leaves off only a plain leading `cd <dir> &&` or `;`, never part of what the command does. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commandLine } from '../apps/web/src/domain/step-line.ts';

test('a plain cd to a bare directory is left off before && or ;', () => {
  assert.equal(commandLine('cd /home/user/project && rg -n total src'), 'rg -n total src');
  assert.equal(commandLine('cd /tmp; alpacawork task get --task T1'), 'alpacawork task get --task T1');
  assert.equal(commandLine('cd ~/work/app-1 &&  pnpm test'), 'pnpm test');
});

test('any other start is kept as written', () => {
  for (const text of ['cd "/my dir" && ls', "cd '/tmp' && ls", 'cd $HOME && ls', 'cd /a\\ b && ls', 'cd /tmp && ', 'cd /tmp',
    'cd /tmp || exit 1', 'cd -P /tmp && ls', 'cd /tmp/* && ls', 'cd $(git rev-parse --show-toplevel) && ls', 'echo cd /tmp && ls',
    'cd /tmp && && ls', 'git status --short'])
    assert.equal(commandLine(text), text, text);
});
