import '../test/sandbox-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const script = new URL('./install-codex-unload-delay.mjs', import.meta.url).pathname;

// A stand-in `codex` that answers JSON-RPC on stdio and records its arguments and each request.
function fakeCodex(dir) {
  const bin = join(dir, 'codex'), log = join(dir, 'requests.jsonl');
  writeFileSync(bin, `#!${process.execPath}
const fs = require('node:fs'); let buf = '';
process.stdin.on('data', d => { for (buf += d; buf.includes('\\n'); buf = buf.slice(buf.indexOf('\\n') + 1)) {
  const m = JSON.parse(buf.slice(0, buf.indexOf('\\n')));
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify([process.argv.slice(2), m]) + '\\n');
  if (m.id) process.stdout.write(JSON.stringify({ id: m.id, result: { status: 'ok', filePath: '/x/config.toml', version: 'v' } }) + '\\n');
} });
`, { mode: 0o700 });
  return { bin, last: () => JSON.parse(readFileSync(log, 'utf8').trim().split('\n').at(-1)) };
}

test('seconds set and default removes thread_unload_delay_secs through codex app-server config/value/write', () => {
  const codex = fakeCodex(mkdtempSync(join(tmpdir(), 'unload-delay-')));
  const run = arg => spawnSync(process.execPath, [script, arg], { env: { ...process.env, CODEX_BIN: codex.bin }, encoding: 'utf8' });
  for (const [arg, value] of [['0', 0], ['default', null]]) {
    assert.equal(run(arg).status, 0);
    const [argv, { method, params }] = codex.last();
    assert.deepEqual([argv, method, params], [['app-server'], 'config/value/write', { keyPath: 'thread_unload_delay_secs', value, mergeStrategy: 'replace' }]);
  }
  assert.equal(run('soon').status, 2);
});
