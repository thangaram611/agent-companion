import '../test/sandbox-home.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Pin the companion home BEFORE importing doctor so companion diagnostics never
// read the operator's settings.json.
const HOME_SANDBOX = mkdtempSync(join(tmpdir(), 'agent-doctor-home-'));
process.env.AGENT_COMPANION_HOME = HOME_SANDBOX;
process.env.CLAUDE_BIN = '/missing-claude';

const { buildDoctorReport, renderDoctorReport } = await import('./doctor.mjs');
const state = await import('./state.mjs');

test.after(() => { rmSync(HOME_SANDBOX, { recursive: true, force: true }); });

function withRuntimeHome(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-doctor-test-'));
  const prior = process.env.AGENT_RUNTIME_DIR;
  process.env.AGENT_RUNTIME_DIR = dir;
  try { return fn(dir); }
  finally {
    if (prior === undefined) delete process.env.AGENT_RUNTIME_DIR;
    else process.env.AGENT_RUNTIME_DIR = prior;
    rmSync(dir, { recursive: true, force: true });
  }
}

// codex/codexLoggedIn describe the SAME `codex` binary the real memoized probe
// shares between the HOST arm (report.codex — plugin-host prereq, unconditional
// --version + plugin subcommands) and the COMPANION arm (report.companions.codex —
// downstream companion readiness, gated by `login status`). Defaults preserve
// every pre-existing assertion here (codex found:true, unconditional) while
// defaulting `codexLoggedIn:false` so a codex COMPANION is present-but-unauthenticated
// unless a test opts in — nothing before this change ever asserted on
// report.companions.codex, so that default is a new, safe addition.
function machineRun({ opencode = false, copilot = false, codex = true, codexLoggedIn = false } = {}) {
  return (cmd, args = []) => {
    const a = args.join(' ');
    if (cmd === 'npm') return { ok: true, output: '10.0.0\nextra' };
    if (cmd === 'jq') return { ok: true, output: 'jq-1.7' };
    if (cmd === 'claude') return { ok: false, output: 'not found' };
    if (cmd === 'codex') {
      if (!codex) return { ok: false, output: 'not found' };
      if (a === '--version') return { ok: true, output: 'codex 0.130.0' };
      if (a === 'plugin add --help') return { ok: true, output: 'usage' };
      if (a === 'plugin marketplace add --help') return { ok: false, output: 'missing' };
      // Live-verified (0.145.0): empty stdout in BOTH the logged-in and
      // logged-out case — exit code alone carries the signal.
      if (a === 'login status') return { ok: codexLoggedIn, output: '' };
    }
    if (/opencode/.test(cmd)) {
      if (!opencode) return { ok: false, output: 'not found' };
      if (a === '--version') return { ok: true, output: 'opencode 1.2.3' };
      if (a === 'models') return { ok: true, output: opencode.models || '' };
    }
    if (/copilot/.test(cmd)) {
      if (!copilot) return { ok: false, output: 'not found' };
      if (a === '--version') return { ok: true, output: 'copilot 1.0.61' };
    }
    return { ok: false, output: 'missing' };
  };
}

test('doctor is companion-aware: configured opencode companion ready → ok', () => {
  withRuntimeHome((home) => {
    const run = machineRun({ opencode: { models: 'anthropic/x' }, copilot: true });
    const report = buildDoctorReport({
      run,
      env: { AGENT_COMPANION_DEFAULT_COMPANION: 'opencode', AGENT_RUNTIME_DIR: home },
      nodeVersion: '26.1.0',
    });

    assert.equal(report.ok, true);
    assert.equal(report.node.version, 'v26.1.0');
    assert.equal(report.claude.found, false);
    assert.equal(report.codex.found, true);
    assert.equal(report.defaultCompanion.companion, 'opencode');
    assert.equal(report.companions.opencode.ready, true);
    assert.equal(report.companions.copilot.ready, true);
    assert.match(report.runtime.codex.dir, new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    const rendered = renderDoctorReport(report);
    assert.match(rendered, /agent-companion doctor: ok/);
    assert.match(rendered, /default companion: opencode \(env\)/);
  });
});

test('opencode-only install is ok without copilot', () => {
  withRuntimeHome(() => {
    const run = machineRun({ opencode: { models: 'anthropic/x' }, copilot: false });
    const report = buildDoctorReport({
      run,
      env: { AGENT_COMPANION_DEFAULT_COMPANION: 'opencode' },
      nodeVersion: '26.1.0',
    });
    assert.equal(report.ok, true);
    assert.equal(report.companions.copilot.ready, false);
    assert.equal(report.companions.copilot.blockers[0].code, 'missing_binary');
  });
});

test('configured companion with a missing binary fails health', () => {
  withRuntimeHome(() => {
    const run = machineRun({ opencode: false, copilot: false });
    const report = buildDoctorReport({
      run,
      env: { AGENT_COMPANION_DEFAULT_COMPANION: 'opencode' },
      nodeVersion: '26.1.0',
    });
    assert.equal(report.ok, false);
    assert.equal(report.companions.opencode.ready, false);
  });
});

test('no configured companion warns about non-persisted selection', () => {
  withRuntimeHome(() => {
    const run = machineRun({ opencode: { models: 'anthropic/x' }, copilot: true });
    const report = buildDoctorReport({ run, env: {}, nodeVersion: '26.1.0' });
    assert.equal(report.defaultCompanion.companion, null);
    assert.equal(report.ok, true); // a companion is selectable
    assert.ok(report.warnings.some((w) => /not persisted/.test(w)));
  });
});

// --------------------------------------------------------- codex host vs companion

test('codex COMPANION readiness (report.companions.codex) is independent of the codex HOST-prereq arm (report.codex)', () => {
  withRuntimeHome(() => {
    // Binary present (host arm finds it) but not logged in — companion readiness
    // is a SEPARATE axis (auth), never implied by host.found alone.
    const loggedOut = machineRun({ opencode: { models: 'anthropic/x' }, copilot: true, codex: true, codexLoggedIn: false });
    const reportOut = buildDoctorReport({ run: loggedOut, env: { AGENT_COMPANION_DEFAULT_COMPANION: 'opencode' }, nodeVersion: '26.1.0' });
    assert.equal(reportOut.codex.found, true);
    assert.equal(reportOut.companions.codex.installed, true);
    assert.equal(reportOut.companions.codex.authenticated, false);
    assert.equal(reportOut.companions.codex.ready, false);

    const loggedIn = machineRun({ opencode: { models: 'anthropic/x' }, copilot: true, codex: true, codexLoggedIn: true });
    const reportIn = buildDoctorReport({ run: loggedIn, env: { AGENT_COMPANION_DEFAULT_COMPANION: 'opencode' }, nodeVersion: '26.1.0' });
    assert.equal(reportIn.codex.found, true);
    assert.equal(reportIn.companions.codex.ready, true);
  });
});

test('codex-as-default-companion with a missing binary fails health', () => {
  withRuntimeHome(() => {
    const run = machineRun({ opencode: { models: 'anthropic/x' }, copilot: true, codex: false });
    const report = buildDoctorReport({ run, env: { AGENT_COMPANION_DEFAULT_COMPANION: 'codex' }, nodeVersion: '26.1.0' });
    assert.equal(report.companions.codex.ready, false);
    assert.equal(report.companions.codex.blockers[0].code, 'missing_binary');
    assert.equal(report.ok, false);
  });
});

test('codexInfo (host arm) honors CODEX_BIN, matching the companion arm binaryEnv', () => {
  withRuntimeHome(() => {
    const seen = [];
    const run = (cmd, args = []) => {
      seen.push(cmd);
      if (cmd === 'npm') return { ok: true, output: '10.0.0' };
      if (cmd === 'jq') return { ok: true, output: 'jq-1.7' };
      if (cmd === '/custom/codex' && args.join(' ') === '--version') return { ok: true, output: 'codex-cli 0.145.0' };
      if (cmd === '/custom/codex' && args.join(' ') === 'plugin add --help') return { ok: true, output: 'usage' };
      return { ok: false, output: 'not found' };
    };
    const report = buildDoctorReport({ run, env: { CODEX_BIN: '/custom/codex' }, nodeVersion: '26.1.0' });
    assert.equal(report.codex.found, true);
    assert.equal(report.codex.version, 'codex-cli 0.145.0');
    assert.ok(seen.includes('/custom/codex'));
    assert.ok(!seen.includes('codex'), 'codexInfo must not fall back to bare PATH `codex` once CODEX_BIN is set');
  });
});

test('doctor reports no job cutoff when retired timeout knobs are set', () => {
  withRuntimeHome(() => {
    const report = buildDoctorReport({ run: machineRun({ opencode: true }), env: {
      AGENT_COMPANION_DEFAULT_COMPANION: 'opencode',
      AGENT_COMPANION_CODEX_TIMEOUT_MS: '1', AGENT_COMPANION_OPENCODE_TIMEOUT_MS: '1',
    } });
    assert.doesNotMatch(JSON.stringify(report) + renderDoctorReport(report), /timeout_ms|timeoutEnv|40 minutes|AGENT_COMPANION_(CODEX|OPENCODE)_TIMEOUT_MS/);
  });
});


test('Claude companion readiness and configured default stay distinct from the host version probe', () => {
  withRuntimeHome(() => {
    for (const auth of [true, false, 'unknown']) {
      const seen = [];
      const run = (cmd, args = []) => {
        seen.push([cmd, args]);
        if (cmd === 'claude') return { ok: true, output: 'host Claude fake' };
        if (cmd === '/fake/claude') return { ok: true, output: args[0] === '--version' ? 'companion Claude fake'
          : auth === 'unknown' ? '' : JSON.stringify({ loggedIn: auth, authMethod: 'claude.ai', apiProvider: 'firstParty' }) };
        return machineRun()(cmd, args);
      };
      const report = buildDoctorReport({ run, env: { CLAUDE_BIN: '/fake/claude', AGENT_COMPANION_DEFAULT_COMPANION: 'claude' } });
      assert.deepEqual(report.claude, { found: true, version: 'host Claude fake', installed: null, installMarkerPresent: false });
      assert.equal(report.companions.claude.version, 'companion Claude fake');
      assert.equal(report.companions.claude.authenticated, auth);
      assert.equal(report.companions.claude.ready, auth !== false);
      assert.equal(report.ok, auth !== false);
      assert.deepEqual(seen.filter(([cmd]) => cmd === 'claude'), [['claude', ['--version']]]);
      assert.ok(seen.some(([cmd, args]) => cmd === '/fake/claude' && args.join(' ') === 'auth status'));
      assert.match(renderDoctorReport(report), /claude/);
    }
  });
});

for (const [version, ok] of [['24.22.3', false], ['26.13.0', true]]) {
  test(`doctor enforces the Node 26 floor for ${version}`, () => {
    withRuntimeHome(() => {
      const report = buildDoctorReport({
        run: machineRun({ opencode: { models: 'anthropic/x' } }),
        env: { AGENT_COMPANION_DEFAULT_COMPANION: 'opencode' },
        nodeVersion: version,
      });
      assert.equal(report.node.ok, ok);
      assert.equal(report.ok, ok);
      assert.equal(report.node.required, '>=26');
      const rendered = renderDoctorReport(report);
      if (!ok) {
        assert.match(rendered, /requires >=26/);
        assert.ok(rendered.includes('agent-companion: Node.js 26 or newer is required (found v24.22.3). Upgrade with `brew upgrade node`, or install the current LTS from https://nodejs.org.'));
      } else {
        assert.match(rendered, /node:    v26.13.0 \(ok\)/);
      }
    });
  });
}

test('native registration and marker evidence survive independent changes', () => {
  const env = { HOME: HOME_SANDBOX, CODEX_HOME: join(HOME_SANDBOX, '.codex'),
    AGENT_COMPANION_DEFAULT_COMPANION: 'codex' };
  for (const host of ['codex', 'copilot']) {
    const dir = join(env.HOME, '.' + host, 'agent-companion');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.host'), host + '\n');
  }
  for (const installed of [true, false]) {
    const run = (cmd, args) => {
      if (args.join(' ') === 'plugin list --json') {
        const list = cmd === 'codex'
          ? { installed: installed ? [{ pluginId: 'agent-companion@agent-companion', installed }] : [] }
          : installed ? [{ name: 'agent-companion', marketplace: 'agent-companion' }] : [];
        return { ok: true, output: JSON.stringify(list) };
      }
      return machineRun({ codexLoggedIn: false, copilot: true })(cmd, args);
    };
    const report = buildDoctorReport({ env, run });
    for (const host of ['codex', 'copilot']) {
      assert.equal(report[host].installMarkerPresent, true);
      assert.equal(report[host].installed, installed);
      assert.equal(report.runtime[host].bridgeLog, join(env.HOME, '.' + host, 'agent-companion/runtime/agent-bridge.log'));
    }
    assert.match(renderDoctorReport(report), /Next: .*codex login/i);
  }
});

test('doctor help and argument errors precede native probes', () => {
  const stamp = join(HOME_SANDBOX, 'probed');
  const binary = join(HOME_SANDBOX, 'fake-cli');
  writeFileSync(binary, '#!/bin/sh\ntouch "$HOME/probed"\n', { mode: 0o755 });
  for (const [arg, status] of [['--help', 0], ['--unknown', 2]]) {
    const r = spawnSync(process.execPath, [join(import.meta.dirname, '../scripts/doctor.mjs'), arg], {
      env: { HOME: HOME_SANDBOX, PATH: '/bin:/usr/bin', CODEX_BIN: binary }, encoding: 'utf8',
    });
    assert.equal(r.status, status);
    assert.match(r.stdout + r.stderr, /Usage: node scripts\/doctor.mjs/);
    assert.equal(existsSync(stamp), false);
  }
});
