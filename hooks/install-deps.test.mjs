// install-deps.sh integration tests via shell-out.
//
// Two bugs are pinned here.
//
// 1. The lock wait budget (60s) exceeded this hook's own timeout in hooks.json
//    (55s). The host killed the hook mid-sleep, so the clean "someone else is
//    installing, let them finish" bail-out was unreachable dead code and a
//    contended SessionStart surfaced as a hard hook kill instead.
//
// 2. The lock recorded the SHELL's pid. npm outlives this shell — the hook has
//    a hard timeout and when the host kills it npm is orphaned and keeps
//    installing — so that kill made the lock instantly look stale and the next
//    session started a second `npm ci` on top of a live one, corrupting exactly
//    the node_modules the lock exists to protect. The lock must track the npm
//    child, not its parent.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync, rmSync, chmodSync, lstatSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const SCRIPT = join(__dirname, 'install-deps.sh');

// A fake plugin root: just enough for install-deps.sh to consider it real.
function makeRoot({ npmBody }) {
  const dir = mkdtempSync(join(tmpdir(), 'install-deps-'));
  const root = join(dir, 'root');
  mkdirSync(join(root, 'bridge-server'), { recursive: true });
  mkdirSync(join(root, 'hooks'), { recursive: true });
  writeFileSync(join(root, 'bridge-server', 'package.json'), JSON.stringify({ name: 'fake', version: '1.0.0' }));
  writeFileSync(join(root, 'hooks', 'node-tools.sh'), readFileSync(join(__dirname, 'node-tools.sh')));
  const npm = join(dir, 'fake-npm');
  writeFileSync(npm, npmBody);
  chmodSync(npm, 0o755);
  const data = join(dir, 'data');
  mkdirSync(data, { recursive: true });
  return { dir, root, npm, data, persist: join(data, 'bridge-server'), lock: join(data, 'bridge-server', '.install.lock.d') };
}

function envFor(ctx, extra = {}) {
  return {
    ...process.env,
    CLAUDE_PLUGIN_ROOT: ctx.root,
    CLAUDE_PLUGIN_DATA: ctx.data,
    AGENT_COMPANION_NPM: ctx.npm,
    ...extra,
  };
}

function runSync(ctx, extra = {}) {
  try {
    const stdout = execFileSync('bash', [SCRIPT], { env: envFor(ctx, extra), encoding: 'utf8' });
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.status, stdout: String(err.stdout || ''), stderr: String(err.stderr || '') };
  }
}

function alive(pid) {
  try { process.kill(Number(pid), 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeoutMs = 8_000, everyMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await sleep(everyMs);
  }
  return false;
}

// --- the budget invariant ---------------------------------------------------

test('lock wait budget stays under this hook\'s timeout in every hooks manifest', () => {
  const src = readFileSync(SCRIPT, 'utf8');
  const declared = Number(src.match(/^HOOK_TIMEOUT_SEC=(\d+)$/m)?.[1]);
  const wait = Number(src.match(/^LOCK_WAIT_SEC=(\d+)$/m)?.[1]);
  assert.ok(Number.isInteger(declared) && Number.isInteger(wait), 'both budgets must be declared');

  // The script is registered by BOTH hosts (hooks.json for Claude Code,
  // hooks-codex.json for Codex). A budget that only clears one host's timeout
  // still leaves the bail-out unreachable on the other.
  const manifests = readdirSync(__dirname).filter((f) => /^hooks.*\.json$/.test(f));
  assert.ok(manifests.length >= 2, `expected both host manifests, found ${manifests.join(', ')}`);

  let registrations = 0;
  for (const file of manifests) {
    const hooks = JSON.parse(readFileSync(join(__dirname, file), 'utf8')).hooks || {};
    for (const groups of Object.values(hooks)) {
      for (const entry of groups.flatMap((g) => g.hooks || [])) {
        if (!entry.command.includes('install-deps.sh')) continue;
        registrations += 1;
        assert.equal(declared, entry.timeout, `${file}: the script's copy of the hook timeout has drifted`);
        assert.ok(
          wait < entry.timeout,
          `${file}: lock wait (${wait}s) must be under the hook timeout (${entry.timeout}s) or the bail-out below it is unreachable`,
        );
      }
    }
  }
  assert.ok(registrations >= 2, `install-deps.sh should be registered by both hosts, found ${registrations}`);
});

// --- lock ownership ---------------------------------------------------------

test('the lock names the npm process, and survives the hook shell being killed', async () => {
  // npm records its own pid, then stays busy long enough for us to inspect.
  const ctx = makeRoot({ npmBody: `#!/bin/bash\necho $$ > "$NPM_PID_FILE"\nsleep 20\nmkdir -p node_modules\n` });
  const pidFile = join(ctx.dir, 'npm.pid');
  const child = spawn('bash', [SCRIPT], { env: envFor(ctx, { NPM_PID_FILE: pidFile }), stdio: 'ignore' });
  try {
    assert.ok(await waitFor(() => existsSync(pidFile)), 'fake npm should have started');
    const npmPid = readFileSync(pidFile, 'utf8').trim();

    assert.ok(await waitFor(() => {
      try { return readFileSync(join(ctx.lock, 'pid'), 'utf8').trim() === npmPid; } catch { return false; }
    }), 'the lock must record npm\'s pid, not the shell\'s');

    // Simulate the host enforcing the hook timeout. SIGKILL: no trap can run.
    child.kill('SIGKILL');
    await new Promise((r) => child.on('close', r));

    assert.ok(existsSync(ctx.lock), 'the lock must outlive the killed shell — npm is still writing node_modules');
    const holder = readFileSync(join(ctx.lock, 'pid'), 'utf8').trim();
    assert.equal(holder, npmPid);
    assert.ok(alive(holder), 'the recorded holder must be the live npm process');

    // A session starting now must see a HELD lock and stand down, rather than
    // reading a dead shell pid, calling the lock stale, and racing npm. The
    // budget is shrunk here only so this assertion doesn't cost 45s of wall
    // clock; the real budget is pinned by the invariant test above.
    const second = runSync(ctx, {
      NPM_PID_FILE: join(ctx.dir, 'npm2.pid'),
      AGENT_COMPANION_LOCK_WAIT_SEC: '2',
    });
    assert.equal(second.code, 0, 'the contended path must bail out cleanly, keeping the hook banner green');
    assert.equal(existsSync(join(ctx.dir, 'npm2.pid')), false, 'a second npm must not run against the same target');

    process.kill(Number(npmPid), 'SIGKILL');
  } finally {
    try { child.kill('SIGKILL'); } catch {}
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test('SIGTERM leaves the lock with the live npm, not released', async () => {
  // SIGKILL (above) runs no trap at all, so it cannot exercise release_lock's
  // ownership guard — the actual core of this fix. SIGTERM does run the trap,
  // and the pre-fix trap (`rm -rf "$LOCK_DIR"` unconditionally) released a lock
  // that npm was still holding while it wrote node_modules.
  const ctx = makeRoot({ npmBody: `#!/bin/bash\necho $$ > "$NPM_PID_FILE"\nsleep 20\nmkdir -p node_modules\n` });
  const pidFile = join(ctx.dir, 'npm.pid');
  const child = spawn('bash', [SCRIPT], { env: envFor(ctx, { NPM_PID_FILE: pidFile }), stdio: 'ignore' });
  try {
    assert.ok(await waitFor(() => existsSync(pidFile)), 'fake npm should have started');
    const npmPid = readFileSync(pidFile, 'utf8').trim();
    assert.ok(await waitFor(() => {
      try { return readFileSync(join(ctx.lock, 'pid'), 'utf8').trim() === npmPid; } catch { return false; }
    }));

    child.kill('SIGTERM');
    await new Promise((r) => child.on('close', r));

    assert.ok(alive(npmPid), 'npm outlives the shell — it is orphaned, not killed');
    assert.ok(existsSync(ctx.lock), 'the trap must NOT release a lock npm still holds');
    assert.equal(readFileSync(join(ctx.lock, 'pid'), 'utf8').trim(), npmPid);

    process.kill(Number(npmPid), 'SIGKILL');
  } finally {
    try { child.kill('SIGKILL'); } catch {}
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test('a killed waiter never disturbs the lock it was waiting on', async () => {
  // A waiter has not armed the trap yet — it acquires the lock and the trap in
  // the same branch — so it owns nothing and must leave the holder's lock
  // exactly as it found it, however it dies.
  const ctx = makeRoot({ npmBody: '#!/bin/bash\nmkdir -p node_modules\n' });
  try {
    mkdirSync(ctx.lock, { recursive: true });
    writeFileSync(join(ctx.lock, 'pid'), String(process.pid));
    const child = spawn('bash', [SCRIPT], { env: envFor(ctx, { AGENT_COMPANION_LOCK_WAIT_SEC: '40' }), stdio: 'ignore' });
    await sleep(400);
    child.kill('SIGTERM');
    await new Promise((r) => child.on('close', r));

    assert.ok(existsSync(ctx.lock), 'the holder\'s lock must survive a waiter being killed');
    assert.equal(readFileSync(join(ctx.lock, 'pid'), 'utf8').trim(), String(process.pid));
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test('a lock with no recorded holder is reclaimed once it is clearly orphaned', async () => {
  // The shell died between `mkdir` and the pid write. Pre-fix, HOLDER was empty
  // so the stale branch never fired and this lock was immortal: deps silently
  // never install, on every future session, forever.
  const ctx = makeRoot({ npmBody: '#!/bin/bash\nmkdir -p node_modules\n' });
  try {
    mkdirSync(ctx.lock, { recursive: true });
    // Age it past LOCK_ORPHAN_MIN (1 min) without waiting a real minute.
    execFileSync('bash', ['-c', `touch -t 200101010000 "${ctx.lock}"`]);

    const r = runSync(ctx, { AGENT_COMPANION_LOCK_WAIT_SEC: '3' });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /deps ready/, 'an orphaned pid-less lock must not wedge installation forever');
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test('a fresh pid-less lock is respected, not stolen', async () => {
  // The counterpart: within the mkdir→pid-write window the lock is legitimate
  // and must be left alone, or the reclaim would itself become a race.
  const ctx = makeRoot({ npmBody: '#!/bin/bash\necho ran >> "$NPM_RUNS"\nmkdir -p node_modules\n' });
  const runs = join(ctx.dir, 'runs');
  try {
    mkdirSync(ctx.lock, { recursive: true });
    const r = runSync(ctx, { NPM_RUNS: runs, AGENT_COMPANION_LOCK_WAIT_SEC: '2' });
    assert.equal(r.code, 0);
    assert.equal(existsSync(runs), false, 'a freshly created lock must be waited on, not reclaimed');
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test('a malformed lock-wait override is ignored without erroring', () => {
  const ctx = makeRoot({ npmBody: '#!/bin/bash\nmkdir -p node_modules\n' });
  try {
    for (const bad of ['abc', '0', '-5', '999']) {
      const r = runSync(ctx, { AGENT_COMPANION_LOCK_WAIT_SEC: bad });
      assert.equal(r.code, 0, `override "${bad}" should not break the hook`);
      assert.doesNotMatch(r.stderr || '', /integer expression expected/, `override "${bad}" leaked a bash error`);
    }
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test('a lock whose holder died is reclaimed', async () => {
  const ctx = makeRoot({ npmBody: '#!/bin/bash\nmkdir -p node_modules\n' });
  try {
    // A provably-dead pid: spawn, await the exit (which also reaps it, so it is
    // not left a zombie that `kill -0` still reports alive), then reuse the number.
    const probe = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
    const deadPid = probe.pid;
    await new Promise((r) => probe.on('close', r));

    mkdirSync(ctx.lock, { recursive: true });
    writeFileSync(join(ctx.lock, 'pid'), String(deadPid));

    const r = runSync(ctx);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /deps ready/, 'a stale lock must not block the install');
    assert.equal(existsSync(ctx.lock), false, 'the lock must be released on success');
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

// --- happy path -------------------------------------------------------------

test('installs once, links node_modules, then no-ops on an unchanged manifest', () => {
  const ctx = makeRoot({ npmBody: '#!/bin/bash\necho run >> "$NPM_RUNS"\nmkdir -p node_modules\n' });
  const runs = join(ctx.dir, 'runs');
  try {
    const first = runSync(ctx, { NPM_RUNS: runs });
    assert.equal(first.code, 0, first.stderr);
    assert.match(first.stdout, /deps ready/);
    assert.equal(readFileSync(runs, 'utf8').trim().split('\n').length, 1);

    const link = join(ctx.root, 'bridge-server', 'node_modules');
    assert.ok(lstatSync(link).isSymbolicLink(), 'node_modules must be symlinked into the plugin root');
    assert.equal(existsSync(ctx.lock), false, 'the lock must be released on success');

    const second = runSync(ctx, { NPM_RUNS: runs });
    assert.equal(second.code, 0);
    assert.equal(second.stdout.trim(), '', 'the unchanged fast path is silent');
    assert.equal(readFileSync(runs, 'utf8').trim().split('\n').length, 1, 'npm must not re-run');
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test('a failing npm reports the failure, clears the hash, and releases the lock', () => {
  const ctx = makeRoot({ npmBody: '#!/bin/bash\necho boom >&2\nexit 1\n' });
  try {
    const r = runSync(ctx);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /npm install failed/);
    assert.equal(existsSync(join(ctx.persist, '.manifest.sha256')), false);
    assert.equal(existsSync(ctx.lock), false, 'a failed install must not leave the lock behind');
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});
