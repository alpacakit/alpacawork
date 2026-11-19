import assert from 'node:assert/strict';
import { test } from 'node:test';
import { performance } from 'node:perf_hooks';
import { redactSecrets } from '@alpacawork/core';

const textSecrets = [
  ['OpenAI token', 'sk-12345678', '[redacted]'],
  ['Anthropic token', 'sk-ant-12345678', '[redacted]'],
  ['GitHub token', `ghp_${'A'.repeat(20)}`, '[redacted]'],
  ['GitHub fine-grained token', `github_pat_${'B'.repeat(20)}`, '[redacted]'],
  ['Slack token', `xoxb-${'C'.repeat(10)}`, '[redacted]'],
  ['Bearer value', 'Bearer abcdefgh', '[redacted]'],
  ['JWT value', `eyJ${'D'.repeat(10)}.${'E'.repeat(10)}`, '[redacted]'],
  ['URL credential', 'postgres://alice:password@localhost/db', 'postgres://[redacted]@localhost/db'],
  ['URL credential with a scheme of digits and +.-', 'see git+ssh.v2-x://alice:password@host',
    'see git+ssh.v2-x://[redacted]@host'],
  ['URL credential after digits and +.- in the same run', '1.-https://alice:password@host',
    '1.-https://[redacted]@host'],
  ['assignment value', 'API_KEY=privatevalue', 'API_KEY=[redacted]'],
  ['colon value', 'API_KEY:privatevalue', 'API_KEY:[redacted]'],
  ['a prefixed secret', 'CLIENT_SECRET=privatevalue', 'CLIENT_SECRET=[redacted]'],
  ['a prefixed access key', 'AWS_SECRET_ACCESS_KEY=privatevalue', 'AWS_SECRET_ACCESS_KEY=[redacted]'],
  ['a prefixed token without a known value shape', 'GITHUB_TOKEN=privatevalue', 'GITHUB_TOKEN=[redacted]'],
  ['a private key', 'private_key=privatevalue', 'private_key=[redacted]'],
  ['an access key', 'access_key=privatevalue', 'access_key=[redacted]'],
  ['a name joined without a mark', 'clientSecret=privatevalue', 'clientSecret=[redacted]'],
  ['a dotted name', 'db.password=privatevalue', 'db.password=[redacted]'],
  ['a command flag', 'run --token=privatevalue now', 'run --token=[redacted] now'],
  ['a quoted assignment', 'GITHUB_TOKEN="privatevalue"', 'GITHUB_TOKEN="[redacted]"'],
  ['an indented YAML line', 'agents:\n  client_secret: privatevalue', 'agents:\n  client_secret: [redacted]'],
  ['a JSON member', '{"token": "privatevalue"}', '{"token": "[redacted]"}'],
  ['a prefixed JSON member with an escaped quote', '{"client_secret":"private\\"value"}', '{"client_secret":"[redacted]"}'],
  ['a flow member', '{token: privatevalue}', '{token: [redacted]}'],
  ['flow members among others', 'a {b: 1, token: privatevalue, c: 2} d', 'a {b: 1, token: [redacted], c: 2} d'],
  ['a flow value of several words', '[{password: private value, note: safe}]', '[{password: [redacted], note: safe}]'],
  ['single quotes', "{'token': 'privatevalue'}", "{'token': '[redacted]'}"],
  ['a printed object', "{ token: 'privatevalue', note: 'safe' }", "{ token: '[redacted]', note: 'safe' }"],
  ['a single-quoted assignment with a space', "TOKEN='private value' next", "TOKEN='[redacted]' next"],
  ['a double-quoted assignment with a space', 'TOKEN="private value" next', 'TOKEN="[redacted]" next'],
  ['a quote inside a single-quoted value', "password: 'it's private'", "password: '[redacted]'"],
  ['a quote inside a double-quoted value', 'password: "pa"ss word"', 'password: "[redacted]"'],
  ['a quote inside a flow value', "{password: 'it's private', note: safe}", "{password: '[redacted]', note: safe}"],
  ['a quote inside an assigned value', "TOKEN='it's private' next", "TOKEN='[redacted]' next"],
  ['an unclosed quote', 'token="private value', 'token="[redacted]'],
  ['a line value of several words', 'password: private value here', 'password: [redacted]'],
  ['a sequence entry', '- token: privatevalue', '- token: [redacted]'],
  ['a block value', 'token: |\n  private\n  value\nnext: ok', 'token: |\n  [redacted]\n  [redacted]\nnext: ok'],
  ['a value on the next line', 'token:\n  privatevalue\nnext: ok', 'token:\n  [redacted]\nnext: ok'],
  ['a URL parameter', 'see https://h/p?token=privatevalue&page=2#top', 'see https://h/p?token=[redacted]&page=2#top'],
  ['a later URL parameter', 'https://h/p?page=2&access_token=privatevalue', 'https://h/p?page=2&access_token=[redacted]'],
  ['a URL fragment parameter', 'https://h/#access_token=privatevalue&x=1', 'https://h/#access_token=[redacted]&x=1'],
  ['a quoted URL', '"https://h/p?api_key=privatevalue"', '"https://h/p?api_key=[redacted]"'],
  ['an assignment inside a quote', '"token=privatevalue"', '"token=[redacted]"'],
  ['an arrow', 'token => privatevalue', 'token => [redacted]'],
  ['a URL password without a user', 'redis://:privatevalue@host:6379', 'redis://[redacted]@host:6379'],
  ['a URL password with an @', 'https://alice:priv@te@host/x', 'https://[redacted]@host/x'],
  ['a passphrase', 'passphrase=privatevalue', 'passphrase=[redacted]'],
  ['a passphrase with its words apart', 'pass_phrase=privatevalue', 'pass_phrase=[redacted]'],
  ['a password with its words apart', 'pass-word=privatevalue', 'pass-word=[redacted]'],
  ['a pair after a semicolon', 'a; token: privatevalue', 'a; token: [redacted]'],
  ['a quoted value after prose', "Invalid token: 'privatevalue'", "Invalid token: '[redacted]'"],
  ['a secret key', 'SECRET_KEY=privatevalue', 'SECRET_KEY=[redacted]'],
  ['a pretty-printed JSON member', '  "token": "privatevalue",', '  "token": "[redacted]",'],
  ['the rest of a line after a closed quote', 'password: "a" private"', 'password: "[redacted]"'],
  ['a comma inside a flow value', '{password: abc,private, note: safe}', '{password: [redacted], note: safe}'],
  ['a value on an unindented next line', 'token:\nprivatevalue', 'token:\n[redacted]'],
  ['a nested flow value', '{"token": {"a": "private"}, "note": "safe"}', '{"token": [redacted], "note": "safe"}'],
  ['a nested flow list', '{ token: [ "private", "value" ], note: "safe" }', '{ token: [redacted], note: "safe" }'],
  ['an assignment inside parentheses', 'foo(token=privatevalue) next', 'foo(token=[redacted]) next'],
  ['an authorization header', 'Authorization: Basic privatevalue', 'Authorization: [redacted]'],
  ['a name joined with a dot', 'api.key=privatevalue', 'api.key=[redacted]'],
] as const;

for (const [name, input, expected] of textSecrets) {
  test(`diagnostic text hides ${name}`, () => {
    const redacted = redactSecrets(input);
    assert.equal(redacted, expected);
    assert.equal(redactSecrets(redacted), redacted);
  });
}

// What the text rules leave, and the one cost of matching a name by its end (bugs.md): a harmless value under such a name.
for (const text of ['token_limit=5', 'api_key_env=X', 'tokens=3', 'retry=3', 'Invalid token: expected a string',
  'see "token" and "secret"', '{"token": 5}', 'Invalid "token": expected a string', 'Bad value, token: expected a string',
  'Error: invalid token: expected a string', 'open /x/token: permission denied', 'https://h/p?token_limit=5&page=2',
  '{token_limit: 5}', '{api_key_env: X}', 'https://host:8080?x=a@b', 'ssh://git@github.com/x', 'token=""', '{"token": null}', 'if (token==null) return',
  'Invalid token:\n  expected a string\n  got number\nnext', 'Missing api key:\n    at foo (a.js:1:2)\nEnd', 'Error: bad password:\nsee the docs',
  'secret_key_env=X', '{token:\nnext'])
  test(`diagnostic text keeps ${text}`, () => assert.equal(redactSecrets(text), text));
test('a harmless value under a name ending in a credential word is hidden too', () => {
  assert.equal(redactSecrets('max_token=100'), 'max_token=[redacted]');
});

// A long tail of white space after many pairs: reading it again for each pair grows with the square.
for (const blank of [' ', '\t', '\u00a0']) {
  test(`redaction stays linear on pairs before a long tail of ${JSON.stringify(blank)}`, () => {
    const input = 'token=a '.repeat(16_000) + blank.repeat(128_000);
    const started = performance.now();
    redactSecrets(input);
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 250, `took ${Math.round(elapsed)}ms`);
  });
}

test('a very long flow value is hidden, not thrown on', () => {
  assert.equal(redactSecrets(`{token: ${'a'.repeat(10_000_000)}`), '{token: [redacted]');
  assert.equal(redactSecrets(`{token: ${'a,'.repeat(5_000_000)}x`), '{token: [redacted]');
});

// A parser's error quotes the source around the fault, broken as written: where a value ends cannot be read from it, so from a
// credential's name on it is hidden whole. The first line, and any other text, keep the rules above.
const excerpt = (line: string, column = 3) =>
  `Nested mappings are not allowed in compact mappings at line 1, column ${column}:\n\n${line}\n${' '.repeat(column - 1)}^\n`;
for (const [line, expected] of [
  ['limits: token: privatevalue', 'limits: token: [redacted]'],
  ['limits: foo token: private value', 'limits: foo token: [redacted]'],
  ['limits: a, token: private,value', 'limits: a, token: [redacted]'],
  ['limits: password=private value', 'limits: password=[redacted]'],
  ['limits: [ "--token", "privatevalue"', 'limits: [ "--token", [redacted]'],
  ['limits: [ --token privatevalue, safe', 'limits: [ --token [redacted]'],
  ['limits: [ {"token": 12345}', 'limits: [ {"token": [redacted]'],
  ['limits: [ {password: abc,privatevalue, note: safe}', 'limits: [ {password: [redacted]'],
  ['limits: [ {password: abc]privatevalue}', 'limits: [ {password: [redacted]'],
  ["limits: [ {token: 'a' privatevalue, b: c}", 'limits: [ {token: [redacted]'],
  ['limits: [ password="a b" privatevalue', 'limits: [ password=[redacted]'],
  ['api key: privatevalue: x', 'api key: [redacted]'],
  ['secret_key: privatevalue: x', 'secret_key: [redacted]'],
  ['token: privatevalue\ntoken: privatevalue', 'token: [redacted]\n[redacted]'],
  ['token: "a\n  privatevalue" x', 'token: [redacted]\n  [redacted]'],
  ['limits: [ {token:\nprivatevalue}', 'limits: [ {token:\n[redacted]'],
  ['limits: [ --token\nprivatevalue', 'limits: [ --token\n[redacted]'],
  ['…ken: private value, note: safe', '…[redacted]'],
  ['…aaa,privatevalue" x', '…[redacted]'],
  ['token: a\n^privatevalue', 'token: [redacted]\n[redacted]'],
  ['token: a\n^\rprivatevalue', 'token: [redacted]\n[redacted]'],
  ['limits: [ {token:\n^privatevalue}', 'limits: [ {token:\n[redacted]'],
  ['limits: [ retry: 3, token_limit: 5, api_key_env: X, tokens: 2', 'limits: [ retry: 3, token_limit: 5, api_key_env: X, tokens: 2'],
] as const) {
  test(`a YAML error's excerpt hides the value on ${JSON.stringify(line)}`, () => {
    const redacted = redactSecrets(excerpt(line));
    assert.equal(redacted, excerpt(expected));
    assert.equal(redactSecrets(redacted), redacted);
  });
}
test("a YAML error's own words hide what they quote from a line with a credential", () => {
  const error = (fault: string, line: string) => `${fault} at line 1, column 8:\n\n${line}\n       ^\n`;
  assert.equal(redactSecrets(error('Not a YAML token: my private: value', 'token: | my private: value')),
    error('Not a YAML token: [redacted]', 'token: [redacted]'));
  assert.equal(redactSecrets(error('Invalid escape sequence \\Uprivate', 'token: "\\Uprivate"')),
    error('Invalid escape sequence [redacted]', 'token: [redacted]'));
  assert.equal(redactSecrets(error('Not a YAML token: a\rprivate', 'token: | a\rprivate')),
    error('Not a YAML token: [redacted]', 'token: [redacted]'));
  assert.equal(redactSecrets(error("Verbatim tags aren't resolved, so !<private> is invalid.", 'token: !<private>')),
    error("Verbatim tags aren't resolved, so [redacted] is invalid.", 'token: [redacted]'));
  assert.equal(redactSecrets(error('The !private! tag has no suffix', 'token: !private!')),
    error('The [redacted] tag has no suffix', 'token: [redacted]'));
  assert.equal(redactSecrets(error('Missing , or : between flow sequence items', '[ token: a')),
    error('Missing , or : between flow sequence items', '[ token: [redacted]'));
  assert.equal(redactSecrets(error('Unexpected flow-map-end token in YAML stream: "}"', 'limits: }')),
    error('Unexpected flow-map-end token in YAML stream: "}"', 'limits: }'));
});

for (const name of ['apiKey', 'accessKey', 'authorization', 'passphrase', 'passwd', 'password', 'privateKey', 'secret', 'secretKey', 'token']) {
  test(`diagnostic text hides a value named ${name}`, () => {
    assert.equal(redactSecrets(`${name}=privatevalue`), `${name}=[redacted]`);
  });
}

// Each input is 64,000 characters of scheme characters that never reach "://"; a scan that tries the run again from
// every position takes over a second on these, a single scan of the run takes a few milliseconds.
for (const [name, unit] of [['words joined by marks', 'a_'], ['credential words', 'token'], ['marks', '-'], ['quoted names', '"a_']] as const) {
  test(`credential names stay linear on long ${name} that are not an assignment`, () => {
    const input = unit.repeat(Math.ceil(64_000 / unit.length)).slice(0, 64_000);
    const started = performance.now();
    assert.equal(redactSecrets(input), input);
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 250, `took ${Math.round(elapsed)}ms`);
  });
}

// The same, for what has a value or opens one: a scan that restarts from each of these, or looks back over what came
// before it, grows with the square.
for (const unit of ['token: ', 'token=', 'token=,', 'token:\n', '{token: a, ', '{', ', ', '[,', '"', "'", '`', 'token="', "token: 'a' ", '?token=a&', ' ', '\n', '\r', 'a\r', '\u2028',
  '…', ' at line 1, column 1:\n\n', 'x at line 1, column 1:\n\ntoken: a\n^\n', 'a://b:c@', 'a_', 'a,']) {
  for (const [name, wrap] of [['alone', (text: string) => text], ['after an open quote', (text: string) => `token: "${text}`],
    ['after a flow opening', (text: string) => `{token='${text}`],
    ['in a flow value', (text: string) => `{token: ${text}`],
    ['in a YAML excerpt', (text: string) => `x at line 1, column 1:\n\n${text}\n^\n`]] as const) {
    test(`redaction stays linear on a long run of ${JSON.stringify(unit)} ${name}`, () => {
      const input = wrap(unit.repeat(Math.ceil(64_000 / unit.length)).slice(0, 64_000));
      const started = performance.now();
      redactSecrets(input);
      const elapsed = performance.now() - started;
      assert.ok(elapsed < 250, `took ${Math.round(elapsed)}ms`);
    });
  }
}

for (const [name, unit] of [['letters', 'a'], ['letters and digits', 'a1'], ['letters, digits and +.-', 'a1+b.c-']] as const) {
  test(`URL credential redaction stays linear on long ${name} that are not a URL`, () => {
    const input = unit.repeat(Math.ceil(64_000 / unit.length)).slice(0, 64_000);
    const started = performance.now();
    assert.equal(redactSecrets(input), input);
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 250, `took ${Math.round(elapsed)}ms`);
    assert.equal(redactSecrets(`${input}://alice:password@host`), `${input}://[redacted]@host`);
  });
}
