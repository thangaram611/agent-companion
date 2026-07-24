#!/usr/bin/env node
// onboard.mjs — first-class companion onboarding for agent-companion.
//
// "Attach your companion." Supported now: opencode, copilot, and codex. This is the
// one place that selects today's target id, explains how to get it ready, and
// (with --set-default) persists the choice. It never prompts for or stores
// provider secrets — auth is delegated to the vendor tools (`opencode` /connect,
// `copilot login`).
//
// Usage:
//   node scripts/onboard.mjs --host claude|codex|both --target opencode|copilot|codex|auto|none [--set-default] [--yes] [--json]
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
  inspectProfiles,
  profileReadinessSummary,
} from '../lib/target-diagnostics.mjs';
import { writeDefaultTarget, readDefaultTarget, writeProfiles, isModelAllowedFor } from '../lib/state.mjs';
import { buildDoctorReport, renderDoctorReport } from '../lib/doctor.mjs';
import { loadProfiles, VALID_STRENGTHS } from '../lib/profile-registry.mjs';

const VALID_HOSTS = new Set(['claude', 'codex', 'both']);
const VALID_TARGET_OPTS = new Set([...TARGET_IDS, 'auto', 'none']);
const PROFILE_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

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
    // Strength-routed profile authoring.
    listProfiles: false,
    defineProfile: undefined,
    companion: undefined,
    model: undefined,
    adapter: undefined,
    strength: undefined, // CSV → array
    assignStrength: undefined,
    setDefaultProfile: undefined,
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
      case '--list-profiles': opts.listProfiles = true; break;
      case '--define-profile': opts.defineProfile = String(valueOf(inline) || '').trim(); break;
      case '--companion': opts.companion = String(valueOf(inline) || '').trim().toLowerCase(); break;
      case '--model': opts.model = String(valueOf(inline) || '').trim(); break;
      case '--adapter': opts.adapter = String(valueOf(inline) || '').trim().toLowerCase(); break;
      case '--strength': opts.strength = String(valueOf(inline) || '').split(',').map((s) => s.trim()).filter(Boolean); break;
      case '--assign-strength': opts.assignStrength = String(valueOf(inline) || '').trim(); break;
      case '--set-default-profile': opts.setDefaultProfile = String(valueOf(inline) || '').trim(); break;
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

// Pure profile planner: validate a profile definition against the existing set
// without IO. Returns { kind:'ok', profile } or { kind:'error', code, message }.
// Persistence (writeProfiles) is the caller's job. OpenCode per-profile models
// are accepted — the worker model plumbing is committed-regression-verified for
// both the cli and server adapters.
export function planProfile({ id, companion, model = null, strengths = [], adapter = null, existing = [] }) {
  const cleanId = String(id || '').trim();
  if (!PROFILE_ID_RE.test(cleanId)) {
    return { kind: 'error', code: 'bad_id', message: `profile id "${id}" must match ${PROFILE_ID_RE}` };
  }
  if (existing.some((p) => p.id === cleanId)) {
    return { kind: 'error', code: 'duplicate_id', message: `profile "${cleanId}" already exists` };
  }
  const comp = String(companion || '').trim().toLowerCase();
  if (!TARGET_IDS.has(comp)) {
    return { kind: 'error', code: 'bad_companion', message: `--companion must be one of ${[...TARGET_IDS].join(', ')} (got "${companion}")` };
  }
  let adp = adapter ? String(adapter).trim().toLowerCase() : null;
  if (adp) {
    if (!['cli', 'server'].includes(adp)) return { kind: 'error', code: 'bad_adapter', message: '--adapter must be cli or server' };
    if (comp !== 'opencode') return { kind: 'error', code: 'bad_adapter', message: '--adapter is opencode-only' };
  }
  const mdl = model ? String(model).trim() : null;
  if (mdl && !isModelAllowedFor(comp, mdl)) {
    return {
      kind: 'error', code: 'bad_model',
      message: comp === 'copilot'
        ? `model "${mdl}" is not a documented Copilot model`
        : `model "${mdl}" must be provider/model form (e.g. anthropic/claude-sonnet-4.6)`,
    };
  }
  const strs = [];
  for (const s of strengths) {
    const label = String(s || '').trim().toLowerCase();
    if (!label) continue;
    if (!VALID_STRENGTHS.has(label)) {
      return { kind: 'error', code: 'bad_strength', message: `strength "${s}" must be one of ${[...VALID_STRENGTHS].join(', ')}` };
    }
    if (!strs.includes(label)) strs.push(label);
  }
  const profile = { id: cleanId, companion: comp, ...(mdl ? { model: mdl } : {}), ...(adp ? { adapter: adp } : {}), strengths: strs };
  return { kind: 'ok', profile };
}

// Pure strength-assignment planner — the deterministic mirror of the server's
// resolveStrength ambiguity rule. A strength already claimed by another profile
// is ambiguous UNLESS a defaultProfile tiebreak is one of the claimants (and so
// actually claims the strength).
export function planStrengthAssignment({ profileId, strength, existing = [], defaultProfile = null }) {
  const label = String(strength || '').trim().toLowerCase();
  if (!VALID_STRENGTHS.has(label)) {
    return { kind: 'error', code: 'bad_strength', message: `strength "${strength}" must be one of ${[...VALID_STRENGTHS].join(', ')}` };
  }
  if (!existing.some((p) => p.id === profileId)) {
    return { kind: 'error', code: 'unknown_profile', message: `profile "${profileId}" does not exist` };
  }
  const otherClaimants = existing.filter((p) => p.id !== profileId && (p.strengths || []).includes(label));
  if (otherClaimants.length === 0) return { kind: 'ok', resolved: true };
  const claimSet = new Set([profileId, ...otherClaimants.map((p) => p.id)]);
  if (defaultProfile && claimSet.has(defaultProfile)) {
    return { kind: 'ok', resolved: true, tiebreak: defaultProfile };
  }
  return {
    kind: 'conflict', code: 'strength_ambiguous',
    candidates: [...claimSet],
    message: `strength "${label}" is already claimed by ${otherClaimants.map((p) => p.id).join(', ')}; set a defaultProfile tiebreak among the claimants (--set-default-profile <id>)`,
  };
}

// Reconstruct the raw authoring doc (profiles[] + defaultProfile) from the
// single-producer registry. The synthesized legacy profile is excluded; a
// file-level defaultProfile that still points to a live profile is carried
// forward.
function loadAuthoringState(env) {
  const reg = loadProfiles({ env });
  const profiles = reg.synthesized
    ? []
    : reg.profiles.filter((p) => !p.synthesized).map((p) => ({
        id: p.id, companion: p.companion,
        ...(p.model ? { model: p.model } : {}),
        ...(p.adapter ? { adapter: p.adapter } : {}),
        strengths: p.strengths.slice(),
      }));
  const dp = (!reg.synthesized && reg.defaultProfile?.value && reg.byId.has(reg.defaultProfile.value))
    ? reg.defaultProfile.value : null;
  return { profiles, defaultProfile: dp };
}

function persistProfiles(profiles, defaultProfile) {
  const doc = { profiles };
  if (defaultProfile) doc.defaultProfile = defaultProfile;
  writeProfiles(doc);
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

function runOpenCodeSmoke(env) {
  const bin = String(env.OPENCODE_BIN || 'opencode').trim() || 'opencode';
  const dir = mkdtempSync(join(tmpdir(), 'agent-onboard-smoke-'));
  try {
    const out = execFileSync(bin, ['run', '--dir', dir, '--format', 'json', 'Reply with the single word: ready'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
      // `timeout` signals the child and then keeps blocking until it actually
      // exits, so with the default (catchable) SIGTERM a companion that traps
      // it — or whose shutdown path is itself wedged — is not bounded at all.
      killSignal: 'SIGKILL',
      env,
    });
    return { supported: true, passed: true, detail: out.trim().split('\n').slice(-1)[0] || '(no output)' };
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
      // See runOpenCodeSmoke's comment — same uncatchable-signal reasoning.
      killSignal: 'SIGKILL',
      env,
    });
    return { supported: true, passed: true, detail: out.trim().split('\n').slice(-1)[0] || '(no output)' };
  } catch (err) {
    return { supported: true, passed: false, detail: String(err.stderr || err.message || 'smoke failed').trim() };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Profile authoring CLI. Returns an exit code; never exits the process itself
// (so it stays unit-testable). Pure planners do the validation; this wires them
// to writeProfiles. Only ids / model names / strength labels are persisted —
// never secrets.
export function runProfileCommand(options, env = process.env, io = console) {
  if (options.listProfiles) {
    const profiles = inspectProfiles({ env });
    if (options.json) { io.log(JSON.stringify({ profiles, defaultProfile: loadAuthoringState(env).defaultProfile }, null, 2)); return 0; }
    if (profiles.length === 0) { io.log('no profiles configured (profiles.json absent or empty).'); return 0; }
    const { defaultProfile } = loadAuthoringState(env);
    io.log(`default profile: ${defaultProfile || 'unset'}`);
    for (const p of profiles) io.log(`  - ${profileReadinessSummary(p)}${p.strengths.length ? ` [${p.strengths.join(', ')}]` : ''}`);
    return 0;
  }

  if (options.defineProfile !== undefined) {
    const { profiles, defaultProfile } = loadAuthoringState(env);
    const plan = planProfile({
      id: options.defineProfile, companion: options.companion, model: options.model,
      adapter: options.adapter, strengths: options.strength || [], existing: profiles,
    });
    if (plan.kind === 'error') { io.error(`[FAIL] ${plan.message}`); return 2; }
    // Mirror the server's ambiguity rule for each declared strength.
    for (const s of plan.profile.strengths) {
      const sa = planStrengthAssignment({ profileId: plan.profile.id, strength: s, existing: [...profiles, plan.profile], defaultProfile });
      if (sa.kind === 'conflict') {
        if (options.yes) { io.error(`[FAIL] ${sa.message}`); return 2; }
        io.error(`[WARN] ${sa.message}`);
      }
    }
    persistProfiles([...profiles, plan.profile], defaultProfile);
    io.log(`[OK] defined profile "${plan.profile.id}" → ${plan.profile.companion}${plan.profile.model ? ` (${plan.profile.model})` : ''}${plan.profile.strengths.length ? ` [${plan.profile.strengths.join(', ')}]` : ''}`);
    return 0;
  }

  if (options.assignStrength !== undefined) {
    const { profiles, defaultProfile } = loadAuthoringState(env);
    const target = profiles.find((p) => p.id === options.assignStrength);
    if (!target) { io.error(`[FAIL] profile "${options.assignStrength}" does not exist`); return 2; }
    const labels = options.strength || [];
    if (labels.length === 0) { io.error('[FAIL] --assign-strength requires --strength <labels>'); return 2; }
    for (const s of labels) {
      const sa = planStrengthAssignment({ profileId: target.id, strength: s, existing: profiles, defaultProfile });
      if (sa.kind === 'error') { io.error(`[FAIL] ${sa.message}`); return 2; }
      if (sa.kind === 'conflict') {
        if (options.yes) { io.error(`[FAIL] ${sa.message}`); return 2; }
        io.error(`[WARN] ${sa.message}`);
      }
      const label = String(s).trim().toLowerCase();
      if (!target.strengths.includes(label)) target.strengths.push(label);
    }
    persistProfiles(profiles, defaultProfile);
    io.log(`[OK] assigned [${labels.join(', ')}] to "${target.id}"`);
    return 0;
  }

  if (options.setDefaultProfile !== undefined) {
    const { profiles } = loadAuthoringState(env);
    if (!profiles.some((p) => p.id === options.setDefaultProfile)) {
      io.error(`[FAIL] profile "${options.setDefaultProfile}" does not exist — define it first`);
      return 2;
    }
    persistProfiles(profiles, options.setDefaultProfile);
    io.log(`[OK] default profile set to "${options.setDefaultProfile}"`);
    return 0;
  }

  return null; // not a profile command
}

const HELP = `agent-companion onboarding

  node scripts/onboard.mjs --target opencode|copilot|codex|auto|none [--host claude|codex|both]
                           [--set-default] [--yes] [--json] [--smoke] [--no-target-check]
  node scripts/onboard.mjs --list-targets [--json]
  node scripts/onboard.mjs --doctor [--json]

  # Strength-routed companion profiles (authoring; ids/models/labels only, no secrets):
  node scripts/onboard.mjs --list-profiles [--json]
  node scripts/onboard.mjs --define-profile <id> --companion opencode|copilot|codex \\
                           [--model <m>] [--adapter cli|server] [--strength reviewer,planner] [--yes]
  node scripts/onboard.mjs --assign-strength <id> --strength <labels> [--yes]
  node scripts/onboard.mjs --set-default-profile <id>

Attach your companion. Supported now: opencode, copilot, and codex. Onboarding never
asks for or stores provider secrets — authenticate with the vendor tools.`;

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

  // Strength-routed profile authoring subcommands. runProfileCommand returns an
  // exit code, or null when no profile flag was passed.
  const profileExit = runProfileCommand(options, env);
  if (profileExit !== null) process.exit(profileExit);

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
      console.error('[FAIL] no --target given and not a tty; pass --target opencode|copilot|codex|none.');
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
