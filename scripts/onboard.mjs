#!/usr/bin/env node
// onboard.mjs — first-class companion onboarding for agent-companion.
//
// "Attach your companion." Supported now: opencode, copilot, codex, and antigravity. This is the
// one place that selects today's target id, explains how to get it ready, and
// (with --set-default) persists the choice. It never prompts for or stores
// provider secrets — auth is delegated to the vendor tools (`opencode` /connect,
// `copilot login`, `scripts/install-antigravity-acp.mjs --login`).
//
// Usage:
//   node scripts/onboard.mjs --host claude|codex|both --target opencode|copilot|codex|antigravity|auto|none [--set-default] [--yes] [--json]
//   node scripts/onboard.mjs --list-targets [--json]
//   node scripts/onboard.mjs --doctor [--json]
//   node scripts/onboard.mjs --target opencode --smoke
//
// Exit codes: 0 ready / host-only / informational; 1 --doctor reported not-ok,
// or an unhandled error; 2 usage error
// (unknown target, ambiguous --target auto under --yes, missing target under
// --yes); 3 target chosen but not ready (actionable next steps printed),
// unless --no-target-check is passed.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import readline from 'node:readline/promises';

import { TARGET_IDS, getTargetById } from '../lib/target-registry.mjs';
import {
  inspectTarget,
  inspectTargets,
  targetReadinessSummary,
  memoizeProbe,
  probeCommand,
} from '../lib/target-diagnostics.mjs';
import { writeDefaultTarget, readDefaultTarget, writeTargetChecks } from '../lib/state.mjs';
import { startOpenCodeRun } from '../bridge-server/opencode-runtime.mjs';
import { createCodexCollector } from '../bridge-server/codex-runtime.mjs';
const VALID_HOSTS = new Set(['claude', 'codex', 'both']);
const VALID_TARGET_OPTS = new Set([...TARGET_IDS, 'auto', 'none']);

export function parseArgs(argv) {
  const opts = {
    host: 'both',
    target: undefined,
    setDefault: false,
    yes: false,
    json: false,
    smoke: false,
    listTargets: false,
    doctor: false,
    noTargetCheck: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const valueOf = (inline) => (inline !== undefined ? inline : argv[++i]);
    const [flag, inline] = a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, undefined];
    switch (flag) {
      case '--host': opts.host = valueOf(inline); break;
      case '--target': opts.target = String(valueOf(inline) || '').trim().toLowerCase(); break;
      case '--set-default': opts.setDefault = true; break;
      case '--yes': case '-y': opts.yes = true; break;
      case '--json': opts.json = true; break;
      case '--plan': opts.plan = true; break;
      case '--smoke': opts.smoke = true; break;
      case '--list-targets': opts.listTargets = true; break;
      case '--doctor': opts.doctor = true; break;
      case '--no-target-check': opts.noTargetCheck = true; break;
      case '-h': case '--help': opts.help = true; break;
      default: opts.unknown = a; break;
    }
  }
  return opts;
}

// Pure planner: given parsed options + inspected target readiness, decide the
// outcome without performing any IO. Returns one of:
//   { kind: 'host-only' }
//   { kind: 'chosen', id, ready, report, writeDefault }
//   { kind: 'ask', candidates }            // interactive selection required
//   { kind: 'error', code, message, candidates? }
export function planOnboard({ options, targets, configuration }) {
  const t = options.target;

  if (t === 'none') return { kind: 'host-only' };
  if (!t && configuration?.exists) return { kind: 'preserved' };

  if (t && TARGET_IDS.has(t)) {
    if (options.setDefault && configuration) {
      if (configuration.defaultTarget.source === 'env' && configuration.defaultTarget.target !== t) {
        return { kind: 'error', code: 'env_override', message: 'AGENT_COMPANION_DEFAULT_TARGET overrides this choice. Change or unset it first.' };
      }
    }
    const report = targets[t];
    return { kind: 'chosen', id: t, ready: !!report?.ready, report, writeDefault: options.setDefault };
  }

  if (t && !VALID_TARGET_OPTS.has(t)) {
    return { kind: 'error', code: 'unknown_target', message: `unknown target "${t}". Supported: ${[...TARGET_IDS].join(', ')}, auto, none.` };
  }

  // t is 'auto' or undefined → choose by readiness.
  const readyIds = Object.values(targets).filter((r) => r.ready).map((r) => r.id);
  if (readyIds.length === 1) {
    const id = readyIds[0];
    return { ...planOnboard({ options: { ...options, target: id }, targets, configuration }), autoSelected: true };
  }
  if (readyIds.length === 0) {
    if (options.yes) {
      return { kind: 'error', code: 'no_ready_target', message: 'no target is ready. Install/authenticate one, use --target none for harness-only setup, or explicitly defer readiness with --target <id> --no-target-check. See --list-targets.' };
    }
    return { kind: 'ask', candidates: Object.keys(targets) };
  }
  // Multiple ready.
  if (options.yes) {
    return { kind: 'error', code: 'ambiguous_target', message: `multiple targets ready (${readyIds.join(', ')}). Pass --target <id>.`, candidates: readyIds };
  }
  return { kind: 'ask', candidates: readyIds };
}

function inspectConfiguration(env, run) {
  const defaultTarget = readDefaultTarget(env);
  const ready = defaultTarget.target ? inspectTarget(defaultTarget.target, { env, run }).ready : null;
  const summary = defaultTarget.target
    ? `${defaultTarget.target} (${defaultTarget.source})${ready === false ? '; needs attention' : ''}`
    : 'no default; select a companion before delegating';
  return { exists: !!defaultTarget.target, defaultTarget, summary };
}

function printTargetReport(report, { json } = {}) {
  if (json) return; // JSON mode prints the whole object once at the end.
  console.log(`\n${report.displayName} — ${targetReadinessSummary(report)}`);
  if (report.binary) console.log(`  binary: ${report.binary}${report.version ? ` (${report.version})` : ''}`);
  for (const b of report.blockers || []) console.log(`  ✗ ${b.message}`);
  for (const w of report.warnings || []) console.log(`  ! ${w.message}`);
  if (report.nextSteps?.length) {
    console.log('  next steps:');
    for (const s of report.nextSteps) console.log(`    - ${s}`);
  }
}

// Opt-in, clearly-warned smoke. Single-shot only for targets with a
// non-interactive run path (OpenCode, Codex). Returns { supported, passed, detail }.
function runSmoke(id, env) {
  if (id === 'opencode') return runOpenCodeSmoke(env);
  if (id === 'codex') return runCodexSmoke(env);
  return { supported: false, passed: null, detail: `${id} has no non-interactive smoke path; start it once interactively to verify.` };
}

async function runOpenCodeSmoke(env) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-onboard-smoke-'));
  try {
    const result = await startOpenCodeRun({
      jobId: `onboard-opencode-${process.pid}`, cwd: dir,
      prompt: 'Reply with the single word: ready',
      model: String(env.AGENT_COMPANION_OPENCODE_MODEL || '').trim() || null,
      env, timeoutMs: 120_000,
    });
    const message = result.summary?.message?.trim() || '';
    return { supported: true, passed: result.status === 'completed' && /^ready[.!]?$/i.test(message), detail: message || result.error || result.status };
  } catch (err) {
    return { supported: true, passed: false, detail: String(err.stderr || err.message || 'smoke failed').trim() };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Config-isolated by design (the one deliberate exception to "inherit the
// user's codex config", D11): without --ignore-user-config the user's
// enabled MCP servers boot on this turn too, and node_repl's 120s
// startup_timeout_sec races this smoke's own 120s budget → false-fail.
// --ephemeral additionally skips persisting a rollout file for this
// throwaway turn (auth still resolves via CODEX_HOME).
function runCodexSmoke(env) {
  const bin = String(env.CODEX_BIN || 'codex').trim() || 'codex';
  const dir = mkdtempSync(join(tmpdir(), 'agent-onboard-smoke-'));
  try {
    const out = execFileSync(bin, [
      'exec', '--sandbox', 'read-only', '--skip-git-repo-check',
      '--ignore-user-config', '--ephemeral', '--json', '-C', dir, '-',
    ], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      input: 'Reply with the single word: ready',
      timeout: 120_000,
      // Bound the synchronous wait even if the child ignores SIGTERM.
      killSignal: 'SIGKILL',
      env,
    });
    const collector = createCodexCollector();
    collector.push(out);
    const result = collector.finish();
    const message = result.message.trim();
    const error = result.turnFailedReason || result.fatalError;
    return {
      supported: true,
      passed: result.turnCompleted && !error && /^ready[.!]?$/i.test(message),
      detail: error || message || 'No assistant reply received.',
    };
  } catch (err) {
    return { supported: true, passed: false, detail: String(err.stderr || err.message || 'smoke failed').trim() };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const HELP = `agent-companion onboarding

  node scripts/onboard.mjs --target opencode|copilot|codex|antigravity|auto|none [--host claude|codex|both]
                           [--set-default] [--yes] [--json] [--plan] [--smoke] [--no-target-check]
  node scripts/onboard.mjs --list-targets [--json]
  node scripts/onboard.mjs --doctor [--json]

Attach your companion. Supported now: opencode, copilot, codex, and antigravity. Onboarding never
asks for or stores provider secrets — authenticate with the vendor tools.
With no --target, existing configuration is preserved. --target none also preserves it.
--plan previews selection and readiness without writes or smoke tasks.
Defaults are written only after readiness/smoke succeeds; --no-target-check explicitly
allows an unready target, but never overrides a failed smoke.`;

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const env = process.env;

  if (options.help) { console.log(HELP); process.exit(0); }
  if (options.unknown) { console.error(`[FAIL] unknown argument: ${options.unknown}`); process.exit(2); }
  if (!VALID_HOSTS.has(options.host)) { console.error(`[FAIL] --host must be claude|codex|both (got ${options.host})`); process.exit(2); }
  if (options.plan && options.smoke) {
    console.error('[FAIL] --plan cannot be combined with --smoke.'); process.exit(2);
  }

  // --doctor: full environment report.
  if (options.doctor) {
    const { buildDoctorReport, renderDoctorReport } = await import('../lib/doctor.mjs');
    const report = buildDoctorReport({ env });
    console.log(options.json ? JSON.stringify(report, null, 2) : renderDoctorReport(report));
    process.exit(report.ok ? 0 : 1);
  }

  const run = memoizeProbe(probeCommand);
  const targets = inspectTargets({ env, run });
  const configuration = inspectConfiguration(env, run);

  // --list-targets: readiness for every supported target.
  if (options.listTargets) {
    if (options.json) {
      console.log(JSON.stringify({ defaultTarget: readDefaultTarget(env), targets }, null, 2));
    } else {
      const def = readDefaultTarget(env);
      console.log(`default target: ${def.target || 'unset'} (${def.source})`);
      for (const r of Object.values(targets)) printTargetReport(r);
    }
    process.exit(0);
  }

  let plan = planOnboard({ options, targets, configuration });

  if (options.plan) {
    const ok = plan.kind !== 'error' && plan.kind !== 'ask' && (plan.kind !== 'chosen' || plan.ready || options.noTargetCheck);
    if (options.json) console.log(JSON.stringify({ ok, plan, configuration, targets }, null, 2));
    else {
      console.log(`Current companion: ${configuration.summary}`);
      console.log(`Plan: ${plan.kind === 'chosen' ? `${plan.writeDefault ? 'set default to' : 'check'} ${plan.id}` : plan.message || 'preserve configuration'}`);
      for (const report of Object.values(targets)) printTargetReport(report);
    }
    process.exit(ok ? 0 : plan.kind === 'chosen' ? 3 : 2);
  }

  // Interactive target selection when required and a tty is available.
  if (plan.kind === 'ask') {
    if (!process.stdin.isTTY) {
      console.error('[FAIL] no --target given and not a tty; pass --target opencode|copilot|codex|antigravity|none.');
      process.exit(2);
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    console.log('Select a target:');
    for (const r of Object.values(targets)) printTargetReport(r);
    const ans = (await rl.question(`\nTarget [${plan.candidates.join('/')}/none]: `)).trim().toLowerCase();
    rl.close();
    if (ans === 'none') plan = { kind: 'host-only' };
    else if (TARGET_IDS.has(ans)) plan = planOnboard({ options: { ...options, target: ans, setDefault: true }, targets, configuration });
    else { console.error(`[FAIL] invalid selection: ${ans}`); process.exit(2); }
  }

  if (plan.kind === 'error') {
    console.error(`[FAIL] ${plan.message}`);
    process.exit(2);
  }

  if (plan.kind === 'host-only' || plan.kind === 'preserved') {
    const msg = `configuration preserved; companion: ${configuration.summary}.`;
    if (options.json) console.log(JSON.stringify({ ok: true, host: options.host, target: null, wroteDefault: false, configuration, note: msg }, null, 2));
    else console.log(`[OK] ${msg}`);
    process.exit(0);
  }

  // plan.kind === 'chosen'
  const { id, report } = plan;
  let wrote = false;
  if (!options.json && plan.writeDefault) {
    console.log(`Plan: default companion ${configuration.summary} → ${id}; model settings preserved.`);
  }

  let smoke = null;
  if (options.smoke) {
    if (!report.ready) {
      smoke = { supported: false, passed: null, detail: 'target not ready; skipping smoke.' };
    } else {
      if (!options.yes && process.stdin.isTTY) {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const ans = (await rl.question(`Run a smoke task against ${report.displayName}? It may consume provider quota. [y/N] `)).trim().toLowerCase();
        rl.close();
        if (ans !== 'y' && ans !== 'yes') smoke = { supported: true, passed: null, detail: 'declined' };
      }
      if (!smoke) smoke = await runSmoke(id, env);
    }
  }

  if (plan.writeDefault && (report.ready || options.noTargetCheck) && smoke?.passed !== false) {
    if (readDefaultTarget({}).target !== id) {
      writeDefaultTarget(id);
      wrote = true;
    }
  }
  if (plan.writeDefault && (report.ready || options.noTargetCheck) && smoke?.passed !== false) {
    writeTargetChecks(Object.fromEntries(Object.entries(targets).map(([id, check]) =>
      [id, { ...check, checkedAt: new Date().toISOString() }])));
  }
  const current = inspectConfiguration(env, run);
  if (options.json) {
    console.log(JSON.stringify({ ok: report.ready && smoke?.passed !== false, host: options.host, target: id, wroteDefault: wrote, autoSelected: !!plan.autoSelected, configuration: current, report, smoke }, null, 2));
  } else {
    if (plan.autoSelected) console.log(`[OK] auto-selected the only ready target: ${id}`);
    printTargetReport(report);
    if (wrote) console.log(`\n[OK] wrote default target: ${id}`);
    else console.log(`\n[INFO] configuration unchanged; companion: ${current.summary}.`);
    if (!report.ready && options.noTargetCheck) console.log('[WARN] readiness deferred by --no-target-check; companion is not ready.');
    if (!smoke) console.log('[INFO] live companion response remains unverified (no smoke requested).');
    if (smoke) console.log(`\nsmoke: ${smoke.supported ? (smoke.passed === null ? 'skipped' : smoke.passed ? 'passed' : 'failed') : 'unsupported'} — ${smoke.detail}`);
  }

  if (smoke?.passed === false || (!report.ready && !options.noTargetCheck)) process.exit(3);
  process.exit(0);
}

// Only run the CLI when invoked directly, so tests can import the pure helpers.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch((err) => { console.error(`[FAIL] ${err.message}`); process.exit(1); });
}
