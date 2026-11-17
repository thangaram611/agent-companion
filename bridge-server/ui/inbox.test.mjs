import '../../test/sandbox-home.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SANDBOX_HOME } from '../../test/sandbox-home.mjs';
import { send } from './inbox.mjs';

const LAUNCH = fileURLToPath(new URL('../../hooks/launch-ui.sh', import.meta.url));
const stateDir = t => {
  const dir = mkdtempSync(join(SANDBOX_HOME, 'inbox-send-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
// The owning bridge's side of the contract: take the one request, answer it.
async function bridge(inbox, outcome) {
  for (let i = 0; i < 200; i++) {
    const name = existsSync(inbox) && readdirSync(inbox).find(file => file.endsWith('.json') && !file.endsWith('.outcome.json'));
    if (name) {
      const request = JSON.parse(readFileSync(join(inbox, name), 'utf8'));
      const mode = statSync(join(inbox, name)).mode & 0o777;
      writeFileSync(join(inbox, `${request.requestId}.outcome.json`), JSON.stringify({ requestId: request.requestId, ...outcome }));
      unlinkSync(join(inbox, name));
      return { request, mode };
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('no request written');
}

test('send writes one private request in the contract shape and takes its outcome once', async t => {
  const dir = stateDir(t), inbox = join(dir, 'inbox', 'run-1');
  const answered = bridge(inbox, { ok: true, status: 'accepted', interventionId: 'i-1' });
  const sent = await send({ dir, executionId: 'run-1', mode: 'queue', text: 'also check the schema', waitMs: 5000, now: () => 1_800_000_000_000 });
  const { request, mode } = await answered;
  assert.deepEqual(request, { requestId: sent.requestId, executionId: 'run-1', mode: 'queue', text: 'also check the schema', at: 1_800_000_000_000 });
  assert.equal(mode, 0o600);
  assert.deepEqual(sent.outcome, { requestId: sent.requestId, ok: true, status: 'accepted', interventionId: 'i-1' });
  assert.deepEqual(readdirSync(inbox), [], 'the outcome is taken, so each is shown once');
});

test('a cancel carries no text, and a bridge that never answers leaves the outcome null', async t => {
  const dir = stateDir(t);
  const sent = await send({ dir, executionId: 'run-2', mode: 'cancel', text: 'ignored', waitMs: 300 });
  assert.equal(sent.outcome, null);
  const [name] = readdirSync(join(dir, 'inbox', 'run-2'));
  const request = JSON.parse(readFileSync(join(dir, 'inbox', 'run-2', name), 'utf8'));
  assert.equal(request.mode, 'cancel');
  assert.equal(Object.hasOwn(request, 'text'), false);
});

test('through launch-ui.sh: send prints one JSON line and refuses bad arguments', async t => {
  const dir = stateDir(t);
  const child = spawn('/bin/bash', [LAUNCH, 'send', dir, 'run-3', 'steer', 'use ripgrep'], { env: { PATH: process.env.PATH, HOME: process.env.HOME } });
  let stdout = '';
  child.stdout.on('data', chunk => stdout += chunk);
  const answered = bridge(join(dir, 'inbox', 'run-3'), { ok: false, status: 'intervention_unavailable', reason: 'state' });
  const code = await new Promise(resolve => child.on('close', resolve));
  await answered;
  assert.equal(code, 0);
  const lines = stdout.split('\n');
  assert.deepEqual(lines.slice(1), ['']);
  assert.deepEqual(JSON.parse(lines[0]).outcome, { requestId: JSON.parse(lines[0]).requestId, ok: false, status: 'intervention_unavailable', reason: 'state' });
  for (const bad of [['relative', 'run-3', 'steer', 'x'], [dir, '../x', 'steer', 'x'], [dir, 'run-3', 'shout', 'x'], [dir, 'run-3', 'steer'],
    [dir, 'run-3', 'steer', '   '], [dir, 'run-3', 'cancel', 'x'], [dir, 'run-3', 'steer', 'x', 'y']]) {
    const refused = spawnSync('/bin/bash', [LAUNCH, 'send', ...bad], { env: { PATH: process.env.PATH, HOME: process.env.HOME }, encoding: 'utf8', timeout: 20_000 });
    assert.equal(refused.status, 2, `${bad.join(' ')}: ${refused.stderr}`);
  }
});
