// Runtime-sandbox guard. Tests that drive a hook which writes under the runtime
// dir must redirect it, or they write into the operator's real
// ~/.{claude,codex}/agent-companion/runtime. The hook falls back there by
// design — a bridge that has never run still needs a heartbeat dir — so the
// redirect has to come from the test, and it has to be MODULE-LEVEL: every
// shell-out in those suites spreads `process.env`, and a per-test env only
// covers the tests someone remembered.
//
// Measured 2026-08-28: hooks/drain-completions.test.mjs fired thirteen tests'
// heartbeats (`sid-A`, `café-1`, `sess_abc_def`, …) into the real heartbeats
// dir on every run. lib/heartbeat.mjs's HOST_LIVENESS_TTL_MS is 30 min, so the
// shared codex broker's idle reaper saw a "live host" for half an hour after
// each `node --test` and a superseded broker never retired. The fix is the
// module-level assignment; this test keeps it there, and extends the rule to
// any hook that grows a runtime-dir write later.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join, relative } from 'node:path';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCAN_DIRS = ['lib', 'bridge-server', 'scripts', 'hooks', 'test'];

function walk(dir, pred) {
  const out = [];
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); }
  catch { return out; }
  for (const ent of entries) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === 'node_modules') continue;
      out.push(...walk(full, pred));
    } else if (pred(ent.name)) {
      out.push(full);
    }
  }
  return out;
}

// A hook "writes under the runtime dir" when it derives a path from
// AGENT_RUNTIME_DIR. Read from the scripts, not listed here, so a hook that
// starts doing so is covered the day it does.
function runtimeWritingHooks() {
  const hooks = walk(join(REPO_ROOT, 'hooks'), (name) => name.endsWith('.sh'));
  return hooks.filter((file) => /AGENT_RUNTIME_DIR/.test(readFileSync(file, 'utf8')));
}

test('at least one hook derives paths from AGENT_RUNTIME_DIR (else this guard is dead)', () => {
  const names = runtimeWritingHooks().map((f) => basename(f));
  assert.ok(names.includes('drain-completions.sh'), `expected drain-completions.sh among ${JSON.stringify(names)}`);
});

const SELF = fileURLToPath(import.meta.url);

// "Drives" means the script name appears in code, not in a comment — this
// file's own comments name the hook, and so may a suite that merely explains
// why it does NOT run it.
function codeOnly(src) {
  return src.split('\n').filter((line) => !/^\s*\/\//.test(line)).join('\n');
}

test('every suite that shells out to a runtime-writing hook sandboxes AGENT_RUNTIME_DIR at module level', () => {
  const hookNames = runtimeWritingHooks().map((f) => basename(f));
  const offenders = [];
  for (const d of SCAN_DIRS) {
    const base = join(REPO_ROOT, d);
    try { statSync(base); } catch { continue; }
    for (const file of walk(base, (name) => name.endsWith('.test.mjs'))) {
      if (file === SELF) continue;
      const src = readFileSync(file, 'utf8');
      const code = codeOnly(src);
      const drives = hookNames.filter((name) => code.includes(name));
      if (!drives.length) continue;
      // Module level: the assignment starts a line, unindented — not inside a
      // test body, where it would cover that test alone and leak from the rest.
      if (!/^process\.env\.AGENT_RUNTIME_DIR\s*=/m.test(src)) {
        offenders.push(`${relative(REPO_ROOT, file)} drives ${drives.join(', ')} without a module-level \`process.env.AGENT_RUNTIME_DIR = <sandbox>\``);
      }
    }
  }
  assert.deepEqual(offenders, [], offenders.join('\n'));
});
