// Single-probe guard. Diagnostics shell out to companion binaries (opencode,
// copilot, claude, codex, npm, jq) SYNCHRONOUSLY, on the bridge's only thread.
// A binary that hangs — stalled on a TTY auth prompt, a wedged network call, a
// half-dead daemon socket — therefore does not just stall the diagnostics call;
// it wedges every in-flight job on that bridge, permanently. Both agent
// templates instruct the subagent to call agent_status({diagnostics:true}), so
// this is a routine code path.
//
// The fix is a timeout, and the way a timeout gets lost is duplication: doctor
// and target-diagnostics each carried their own copy of the exec helper and
// neither had one. This test fails on any new synchronous exec that isn't the
// single shared probe.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCAN_DIRS = ['lib', 'bridge-server', 'scripts', 'hooks'];
// probeCommand is the sanctioned definition for anything the BRIDGE runs, since
// only there does a hang stall other people's jobs. The two exceptions are
// standalone processes with their own lifecycle, so they may call out directly —
// but they must still bound the call, which the second test enforces.
const ALLOWED = new Set(['lib/target-diagnostics.mjs']);
const BOUNDED_EXCEPTIONS = new Set([
  'scripts/onboard.mjs',
  'scripts/copilot-acp-daemon.mjs',
  'scripts/validate-codex-release.mjs',
]);

function walk(dir) {
  const out = [];
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); }
  catch { return out; }
  for (const ent of entries) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === 'node_modules') continue;
      out.push(...walk(full));
    } else if (ent.name.endsWith('.mjs') && !ent.name.endsWith('.test.mjs')) {
      out.push(full);
    }
  }
  return out;
}

test('synchronous shell-outs go through the shared probe', () => {
  const offenders = [];
  for (const d of SCAN_DIRS) {
    const base = join(REPO_ROOT, d);
    try { statSync(base); } catch { continue; }
    for (const file of walk(base)) {
      const rel = relative(REPO_ROOT, file);
      if (ALLOWED.has(rel) || BOUNDED_EXCEPTIONS.has(rel)) continue;
      const src = readFileSync(file, 'utf8');
      for (const token of ['execFileSync', 'execSync', 'spawnSync']) {
        if (src.includes(token)) {
          offenders.push(`${rel} calls ${token} directly — route it through probeCommand (lib/target-diagnostics.mjs) so it inherits the timeout`);
        }
      }
    }
  }
  assert.deepEqual(offenders, [], offenders.join('\n'));
});

test('the shared probe passes a timeout to every synchronous exec it makes', () => {
  const src = readFileSync(join(REPO_ROOT, 'lib/target-diagnostics.mjs'), 'utf8');
  const calls = src.split('execFileSync(').slice(1);
  assert.ok(calls.length > 0, 'expected at least one execFileSync in the shared probe');
  for (const call of calls) {
    // Look only at the option object of this call, not the rest of the file.
    const opts = call.slice(0, call.indexOf('})'));
    assert.match(opts, /timeout:/, 'every execFileSync in the shared probe must pass a timeout');
  }
});

test('the sanctioned exceptions still bound every synchronous exec', () => {
  // These run in their own process rather than the bridge, so they are allowed
  // their own call — but "not on the bridge thread" is not a reason to hang.
  const offenders = [];
  for (const rel of BOUNDED_EXCEPTIONS) {
    const src = readFileSync(join(REPO_ROOT, rel), 'utf8');
    for (const token of ['execFileSync(', 'execSync(', 'spawnSync(']) {
      let from = 0;
      for (;;) {
        const at = src.indexOf(token, from);
        if (at === -1) break;
        from = at + token.length;
        // Skip the import statement itself.
        if (/[.\w]/.test(src[at - 1] || '')) continue;
        const call = src.slice(at, src.indexOf('})', at));
        if (!/timeout:/.test(call)) offenders.push(`${rel}: ${token} without a timeout`);
        if (!/killSignal:\s*'SIGKILL'/.test(call)) {
          offenders.push(`${rel}: ${token} without killSignal SIGKILL — a catchable signal does not bound a child that ignores it`);
        }
      }
    }
  }
  assert.deepEqual(offenders, [], offenders.join('\n'));
});

test('the shared probe kills with an uncatchable signal', () => {
  // `timeout` alone signals the child and keeps blocking until it exits, so a
  // catchable killSignal leaves the hang unbounded while still reporting a
  // timeout. This is the difference between the fix working and only looking
  // like it works.
  const src = readFileSync(join(REPO_ROOT, 'lib/target-diagnostics.mjs'), 'utf8');
  assert.match(src, /killSignal:\s*'SIGKILL'/);
});
