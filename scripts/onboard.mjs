#!/usr/bin/env node
// onboard.mjs — first-class, target-first onboarding for agent-companion.
//
// "Bring your target." Supported now: opencode and copilot. This is the one
// place that selects a target, explains how to get it ready, and (with
// --set-default) persists the choice. It never prompts for or stores provider
// secrets — auth is delegated to the vendor tools (`opencode` /connect,
// `copilot login`).
//
// Usage:
//   node scripts/onboard.mjs --host claude|codex|both --target opencode|copilot|auto|none [--set-default] [--yes] [--json]
//   node scripts/onboard.mjs --list-targets [--json]
//   node scripts/onboard.mjs --doctor [--json]
//   node scripts/onboard.mjs --target opencode --smoke
//
// Exit codes: 0 ready / host-only / informational; 2 usage error
// (unknown target, ambiguous --target auto under --yes, missing target under
// --yes); 3 target chosen but not ready (actionable next steps printed),
// unless --no-target-check is passed.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import readline from 'node:readline/promises';

import { TARGET_IDS, getTargetById } from '../lib/target-registry.mjs';
import {
  inspectTarget,
  inspectTargets,
  targetReadinessSummary,
} from '../lib/target-diagnostics.mjs';
import { writeDefaultTarget, readDefaultTarget } from '../lib/state.mjs';
import { buildDoctorReport, renderDoctorReport } from '../lib/doctor.mjs';

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
export function planOnboard({ options, targets }) {
  const t = options.target;

  if (t === 'none') return { kind: 'host-only' };

  if (t && TARGET_IDS.has(t)) {
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
    return { kind: 'chosen', id, ready: true, report: targets[id], writeDefault: options.setDefault, autoSelected: true };
  }
  if (readyIds.length === 0) {
    if (options.yes) {
      return { kind: 'error', code: 'no_ready_target', message: 'no target is ready. Install/authenticate one, or pass --target <id> to write the choice anyway. See --list-targets.' };
    }
    return { kind: 'ask', candidates: Object.keys(targets) };
  }
  // Multiple ready.
  if (options.yes) {
    return { kind: 'error', code: 'ambiguous_target', message: `multiple targets ready (${readyIds.join(', ')}). Pass --target <id>.`, candidates: readyIds };
  }
  return { kind: 'ask', candidates: readyIds };
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
// non-interactive run path (OpenCode). Returns { supported, passed, detail }.
function runSmoke(id, env) {
  if (id !== 'opencode') {
    return { supported: false, passed: null, detail: `${id} has no non-interactive smoke path; start it once interactively to verify.` };
  }
  const bin = String(env.OPENCODE_BIN || 'opencode').trim() || 'opencode';
  const dir = mkdtempSync(join(tmpdir(), 'agent-onboard-smoke-'));
  try {
    const out = execFileSync(bin, ['run', '--dir', dir, '--format', 'json', 'Reply with the single word: ready'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
      env,
    });
    return { supported: true, passed: true, detail: out.trim().split('\n').slice(-1)[0] || '(no output)' };
  } catch (err) {
    return { supported: true, passed: false, detail: String(err.stderr || err.message || 'smoke failed').trim() };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const HELP = `agent-companion onboarding

  node scripts/onboard.mjs --target opencode|copilot|auto|none [--host claude|codex|both]
                           [--set-default] [--yes] [--json] [--smoke] [--no-target-check]
  node scripts/onboard.mjs --list-targets [--json]
  node scripts/onboard.mjs --doctor [--json]

Bring your target. Supported now: opencode and copilot. Onboarding never asks
for or stores provider secrets — authenticate with the vendor tools.`;

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const env = process.env;

  if (options.help) { console.log(HELP); process.exit(0); }
  if (options.unknown) { console.error(`[FAIL] unknown argument: ${options.unknown}`); process.exit(2); }
  if (!VALID_HOSTS.has(options.host)) { console.error(`[FAIL] --host must be claude|codex|both (got ${options.host})`); process.exit(2); }

  // --doctor: full environment report.
  if (options.doctor) {
    const report = buildDoctorReport({ env });
    console.log(options.json ? JSON.stringify(report, null, 2) : renderDoctorReport(report));
    process.exit(report.ok ? 0 : 1);
  }

  const targets = inspectTargets({ env });

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

  let plan = planOnboard({ options, targets });

  // Interactive target selection when required and a tty is available.
  if (plan.kind === 'ask') {
    if (!process.stdin.isTTY) {
      console.error('[FAIL] no --target given and not a tty; pass --target opencode|copilot|none.');
      process.exit(2);
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    console.log('Select a target:');
    for (const r of Object.values(targets)) printTargetReport(r);
    const ans = (await rl.question(`\nTarget [${plan.candidates.join('/')}/none]: `)).trim().toLowerCase();
    rl.close();
    if (ans === 'none') plan = { kind: 'host-only' };
    else if (TARGET_IDS.has(ans)) plan = { kind: 'chosen', id: ans, ready: !!targets[ans]?.ready, report: targets[ans], writeDefault: true };
    else { console.error(`[FAIL] invalid selection: ${ans}`); process.exit(2); }
  }

  if (plan.kind === 'error') {
    console.error(`[FAIL] ${plan.message}`);
    process.exit(2);
  }

  if (plan.kind === 'host-only') {
    const msg = 'host/plugin surface only; no target configured. First send must pass an explicit target or run onboarding with --target.';
    if (options.json) console.log(JSON.stringify({ ok: true, host: options.host, target: null, note: msg }, null, 2));
    else console.log(`[OK] ${msg}`);
    process.exit(0);
  }

  // plan.kind === 'chosen'
  const { id, report } = plan;
  let wrote = false;
  if (plan.writeDefault) {
    writeDefaultTarget(id);
    wrote = true;
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
      if (!smoke) smoke = runSmoke(id, env);
    }
  }

  if (options.json) {
    console.log(JSON.stringify({ ok: report.ready, host: options.host, target: id, wroteDefault: wrote, autoSelected: !!plan.autoSelected, report, smoke }, null, 2));
  } else {
    if (plan.autoSelected) console.log(`[OK] auto-selected the only ready target: ${id}`);
    printTargetReport(report);
    if (wrote) console.log(`\n[OK] wrote default target: ${id}`);
    else console.log(`\n[INFO] not persisted (pass --set-default to write it as the bridge default).`);
    if (smoke) console.log(`\nsmoke: ${smoke.supported ? (smoke.passed === null ? 'skipped' : smoke.passed ? 'passed' : 'failed') : 'unsupported'} — ${smoke.detail}`);
  }

  if (!report.ready && !options.noTargetCheck) process.exit(3);
  process.exit(0);
}

// Only run the CLI when invoked directly, so tests can import the pure helpers.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(`[FAIL] ${err.message}`); process.exit(1); });
}
