import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commandOf } from '@alpacawork/backend/test-dist/runs/shell-command.js';

test('work labels come only from a single literal CLI invocation', () => {
  for (const [command, key] of [
    ['alpacawork task get --task T157', 'task.get'],
    ['alpacawork task new --title "one task"', 'task.new'],
    ["/bin/bash -lc 'alpacawork task update --task T1 --title changed'", 'task.update'],
    ["alpacawork task report --state doing --description-file - <<'EOF'\n$not_expanded\nalpacawork task new is data\nEOF\n", 'task.report'],
    ["alpacawork task request --task T1 --instruction-file - <<'EOF'\n\nEOF", 'task.request'],
    ["alpacawork task new --title 'a; b $(literal) | echo'", 'task.new'],
  ]) assert.equal(commandOf(command), key, command);
  for (const command of [undefined, '', 'echo alpacawork task new', 'alpacawork task new --help',
    'alpacawork task get -h', 'alpacawork task get | head', 'alpacawork task new; alpacawork task get',
    'alpacawork\rtask new', 'alpacawork\u00a0task new',
    'alpacawork task new\nalpacawork task update', 'cd /tmp && alpacawork task get',
    'X=1 alpacawork task new', 'alpacawork task new --title "$X"', 'alpacawork task get > result',
    'alpacawork task get &', 'alpacawork task archive', 'bash -lc "bash -lc \'alpacawork task new\'"',
    "alpacawork task new <<EOF\n$(anything)\nEOF", "alpacawork task new <<'EOF'\ndata\nEOF\ntrue",
    'alpacawork task new --title ' + 'a'.repeat(65536)]) assert.equal(commandOf(command), null, String(command));
});
