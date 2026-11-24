#!/usr/bin/env node
// onboard.mjs — first-class companion onboarding for agent-companion.
//
// "Attach your companion." This is the
// one place that selects today's companion id, explains how to get it ready, and
// (with --set-default) persists the choice and optional per-companion model. It never prompts for or stores
// provider secrets — auth is delegated to the vendor tools (`opencode` /connect,
// `copilot login`, `agy acp --login`).
//
// Usage:
//   node scripts/onboard.mjs --host <host|both> --companion <id|auto|none> [--model <id|inherit>] [--set-default] [--yes] [--json]
//   node scripts/onboard.mjs --list-companions [--json]
//   node scripts/onboard.mjs --doctor [--json]
//   node scripts/onboard.mjs --companion opencode --smoke
//
// Exit codes: 0 ready / host-only / informational; 1 --doctor reported not-ok,
// or an unhandled error; 2 usage error
// (unknown companion, ambiguous --companion auto under --yes, missing companion under
// --yes); 3 companion chosen but not ready (actionable next steps printed),
// unless --no-companion-check is passed.

import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import readline from 'node:readline/promises';

import { COMPANION_IDS, getCompanionById, modelHint } from '../lib/companion-registry.mjs';
import {
  inspectCompanions,
  companionReadinessSummary,
  memoizeProbe,
  probeCommand,
} from '../lib/companion-diagnostics.mjs';
import { migrateDefaults, previewDefaults, writeDefaultCompanion, readDefaultCompanion, writeCompanionChecks,
  readDefaultModel, writeDefaultModel, clearDefaultModel, isModelAllowedFor } from '../lib/state.mjs';
import { loadSettings, settingsPath } from '../lib/settings.mjs';
import { Controller } from '../bridge-server/controller/controller.mjs';
import { createProviders } from '../bridge-server/providers.mjs';
import { HOSTS, stateDirs } from '../lib/hosts/index.mjs';
import { Records } from '../bridge-server/controller/records.mjs';
const VALID_HOSTS = new Set([...Object.keys(HOSTS), 'both', 'all']);
const VALID_COMPANION_OPTS = new Set([...COMPANION_IDS, 'auto', 'none']);

export function parseArgs(argv) {
  const opts = {
    host: 'both',
    companion: undefined,
    setDefault: false,
    yes: false,
    json: false,
    smoke: false,
    listCompanions: false,
    doctor: false,
    noCompanionCheck: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const valueOf = (inline) => (inline !== undefined ? inline : argv[++i]);
    const [flag, inline] = a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, undefined];
    switch (flag) {
      case '--host': opts.host = valueOf(inline); break;
      case '--companion': opts.companion = String(valueOf(inline) || '').trim().toLowerCase(); break;
      case '--model': opts.model = String(inline ?? (argv[i + 1]?.startsWith('-') ? '' : argv[++i]) ?? '').trim(); break;
      case '--set-default': opts.setDefault = true; break;
      case '--yes': case '-y': opts.yes = true; break;
      case '--json': opts.json = true; break;
      case '--plan': opts.plan = true; break;
      case '--smoke': opts.smoke = true; break;
      case '--list-companions': opts.listCompanions = true; break;
      case '--doctor': opts.doctor = true; break;
      case '--no-companion-check': opts.noCompanionCheck = true; break;
      case '-h': case '--help': opts.help = true; break;
      default: opts.unknown = a; break;
    }
  }
  return opts;
}

// Pure planner: given parsed options + inspected companion readiness, decide the
// outcome without performing any IO. Returns one of:
//   { kind: 'host-only' }
//   { kind: 'chosen', id, ready, report, writeDefault }
//   { kind: 'ask', candidates }            // interactive selection required
//   { kind: 'error', code, message, candidates? }
export function planOnboard({ options, companions, configuration }) {
  const t = options.companion;

  if (options.model !== undefined) {
    if (!COMPANION_IDS.has(t)) return { kind: 'error', code: 'model_companion_required', message: '--model requires an explicit --companion <companion> (not auto or none).' };
    if (!options.model) return { kind: 'error', code: 'model_required', message: '--model requires a value: <id|inherit>.' };
    if (!companions[t]?.capabilities?.modelSelection) {
      return { kind: 'error', code: 'CAPABILITY_UNAVAILABLE', message: `companion "${t}" cannot select a model` };
    }
    if (options.model !== 'inherit' && !isModelAllowedFor(t, options.model)) {
      // Mirror resolveRouting's hints without importing the MCP server during setup.
      const hint = modelHint(t);
      return { kind: 'error', code: 'MODEL_NOT_ALLOWED', message: `model "${options.model}" is not valid for ${t}. ${hint}` };
    }
  }

  const current = companions[COMPANION_IDS.has(t) ? t : configuration?.defaultCompanion?.companion]?.defaultModel
    ?? configuration?.defaultModel;
  const model = { requested: options.model ?? null,
    action: options.model === undefined ? 'none' : options.model === 'inherit' ? 'clear' : 'set',
    current: current?.model ?? null, source: current?.source ?? 'unset' };
  if (t === 'none') return { kind: 'host-only', model };
  if (!t && configuration?.exists) return { kind: 'preserved', model };

  if (t && COMPANION_IDS.has(t)) {
    if (options.setDefault && configuration) {
      if (configuration.defaultCompanion.source === 'env' && configuration.defaultCompanion.companion !== t) {
        return { kind: 'error', code: 'env_override', message: 'AGENT_COMPANION_DEFAULT_COMPANION overrides this choice. Change or unset it first.' };
      }
    }
    const report = companions[t];
    return { kind: 'chosen', id: t, ready: !!report?.ready, report, writeDefault: options.setDefault, model };
  }

  if (t && !VALID_COMPANION_OPTS.has(t)) {
    return { kind: 'error', code: 'unknown_companion', message: `unknown companion "${t}". Supported: ${[...COMPANION_IDS].join(', ')}, auto, none.` };
  }

  // t is 'auto' or undefined → choose by readiness.
  const readyIds = Object.values(companions).filter((r) => r.ready).map((r) => r.id);
  if (readyIds.length === 1) {
    const id = readyIds[0];
    return { ...planOnboard({ options: { ...options, companion: id }, companions, configuration }), autoSelected: true };
  }
  if (readyIds.length === 0) {
    if (options.yes) {
      return { kind: 'error', code: 'no_ready_companion', message: 'no companion is ready. Install/authenticate one, use --companion none for host-only setup, or explicitly defer readiness with --companion <id> --no-companion-check. Run node scripts/onboard.mjs --list-companions.' };
    }
    return { kind: 'ask', candidates: Object.keys(companions) };
  }
  // Multiple ready.
  if (options.yes) {
    return { kind: 'error', code: 'ambiguous_companion', message: `multiple companions ready (${readyIds.join(', ')}). Pass --companion <id>.`, candidates: readyIds };
  }
  return { kind: 'ask', candidates: readyIds };
}

function inspectConfiguration(defaultCompanion, companions) {
  const ready = defaultCompanion.companion ? companions[defaultCompanion.companion]?.ready : null;
  const summary = defaultCompanion.companion
    ? `${defaultCompanion.companion} (${defaultCompanion.source})${ready === false ? '; needs attention' : ''}`
    : 'no default; select a companion before delegating';
  return { exists: !!defaultCompanion.companion, defaultCompanion, summary };
}

function printCompanionReport(report, { json } = {}) {
  if (json) return; // JSON mode prints the whole object once at the end.
  console.log(`\n${report.displayName} — ${companionReadinessSummary(report)}`);
  if (report.defaultModel) console.log(`  default model: ${report.defaultModel.model || 'inherit'} (${report.defaultModel.source})`);
  if (report.binary) console.log(`  binary: ${report.binary}${report.version ? ` (${report.version})` : ''}`);
  for (const b of report.blockers || []) console.log(`  ✗ ${b.message}`);
  for (const w of report.warnings || []) console.log(`  ! ${w.message}`);
  if (report.nextSteps?.length) {
    console.log('  next steps:');
    for (const s of report.nextSteps) console.log(`    - ${s}`);
  }
}

function modelIntent(model) {
  const intent = model?.action === 'set' ? `model ${model.requested}`
    : model?.action === 'clear' ? 'model inherit (clear saved default)' : 'model settings preserved';
  return model?.action !== 'none' && model?.source === 'env'
    ? `${intent}; effective model ${model.current} (environment override)` : intent;
}

// Opt-in smoke: one controller-owned job, with a two-minute budget.
export async function runSmoke(id, env, controllerOptions = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'agent-onboard-smoke-')));
  const controller = new Controller({ env, records: new Records({ dir: join(dir, 'state') }),
    providers: createProviders(env),
    ...controllerOptions });
  const abort = new AbortController();
  const timer = controller.clock.setTimeout(() => abort.abort(), 120_000);
  const thread = `onboard-${process.pid}`;
  let jobId;
  try {
    ({ jobId } = await controller.send({ thread, companion: id, cwd: dir,
      text: 'Reply with the single word: ready', signal: abort.signal }));
    await controller.wait({ thread, jobId, timeoutMs: 120_000, signal: abort.signal });
    const result = controller.status({ jobId })?.result;
    const message = result?.text?.trim() || '';
    return { supported: true, passed: result?.outcome === 'completed' && /^ready[.!]?$/i.test(message),
      detail: message || result?.detail || result?.outcome || 'smoke budget expired' };
  } catch (err) {
    return { supported: true, passed: false, detail: String(err.message || 'smoke failed').trim() };
  } finally {
    controller.clock.clearTimeout(timer);
    if (jobId) await controller.cancel({ thread, jobId });
    rmSync(dir, { recursive: true, force: true });
  }
}
const HELP = `agent-companion onboarding

  node scripts/onboard.mjs --companion ${[...VALID_COMPANION_OPTS].join('|')} [--host ${[...VALID_HOSTS].join('|')}]
                           [--model <id|inherit>] [--set-default] [--yes] [--json] [--plan] [--smoke] [--no-companion-check]
  node scripts/onboard.mjs --list-companions [--json]
  node scripts/onboard.mjs --doctor [--json]

Attach your companion. Supported now: ${new Intl.ListFormat('en').format([...COMPANION_IDS])}. Onboarding never
asks for or stores provider secrets — authenticate with the vendor tools.
With no --companion, existing configuration is preserved. --companion none also preserves it.
--plan previews selection without changing defaults. Native CLI probes can initialize profiles, caches or databases.
--model requires an explicit companion; inherit clears its saved default.
Without --set-default, model changes are previewed only.
Defaults are written only after readiness/smoke succeeds; --no-companion-check explicitly
allows an unready companion, but never overrides a failed smoke.`;

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const env = process.env;

  if (options.help) { console.log(HELP); process.exit(0); }
  if (options.unknown) { console.error(`[FAIL] unknown argument: ${options.unknown}`); process.exit(2); }
  if (!VALID_HOSTS.has(options.host)) { console.error(`[FAIL] --host must be ${[...VALID_HOSTS].join('|')} (got ${options.host})`); process.exit(2); }
  if (options.plan && options.smoke) {
    console.error('[FAIL] --plan cannot be combined with --smoke.'); process.exit(2);
  }

  const settings = options.plan ? previewDefaults({ env }) : migrateDefaults({ env });
  if (!options.plan) {
    for (const { dir, host } of stateDirs(env)) {
      if (options.host === 'all' || (options.host === 'both' && [HOSTS.claude.id, HOSTS.codex.id].includes(host)) || options.host === host || env.AGENT_COMPANION_HOME) new Records({ dir });
    }
  }
  const defaultCompanion = readDefaultCompanion(env, console.warn, settings);
  const run = memoizeProbe(probeCommand);
  const hostOnlyPreview = options.plan && options.companion === 'none' && !options.listCompanions && !options.doctor;
  const companions = hostOnlyPreview ? {} : inspectCompanions({ env, run, configuredCompanion: defaultCompanion.companion });
  for (const [id, report] of Object.entries(companions)) {
    report.capabilities = getCompanionById(id).capabilities;
    report.defaultModel = readDefaultModel(id, env, console.warn, settings);
  }
  const configuration = inspectConfiguration(defaultCompanion, companions);
  if (hostOnlyPreview && COMPANION_IDS.has(defaultCompanion.companion)) {
    configuration.defaultModel = readDefaultModel(defaultCompanion.companion, env, console.warn, settings);
  }
  let plan = planOnboard({ options, companions, configuration });
  if (options.model !== undefined && plan.kind === 'error' && (!options.plan || options.listCompanions || options.doctor)) {
    console.error(`[FAIL] ${plan.code}: ${plan.message}`);
    process.exit(2);
  }

  // --doctor: full environment report.
  if (options.doctor) {
    const { inspectDoctor, renderDoctorReport } = await import('../lib/doctor.mjs');
    const report = await inspectDoctor({ env });
    console.log(options.json ? JSON.stringify(report, null, 2) : renderDoctorReport(report));
    process.exit(report.ok ? 0 : 1);
  }

  // --list-companions: readiness for every supported companion.
  if (options.listCompanions) {
    if (options.json) {
      console.log(JSON.stringify({ defaultCompanion, companions }, null, 2));
    } else {
      console.log(`default companion: ${defaultCompanion.companion || 'unset'} (${defaultCompanion.source})`);
      for (const r of Object.values(companions)) printCompanionReport(r);
    }
    process.exit(0);
  }

  if (options.plan) {
    if (plan.writeDefault && (plan.ready || options.noCompanionCheck)) {
      try { loadSettings(settingsPath(env)); }
      catch (err) { plan = { kind: 'error', code: 'unreadable_settings', message: err.message }; }
    }
    if (plan.kind === 'error') console.error(`[FAIL] ${plan.code}: ${plan.message}`);
    const ok = plan.kind !== 'error' && plan.kind !== 'ask' && (plan.kind !== 'chosen' || plan.ready || options.noCompanionCheck);
    if (options.json) console.log(JSON.stringify({ ok, plan, model: plan.model ?? { requested: options.model ?? null, action: 'none', current: null, source: 'unset' }, configuration, companions }, null, 2));
    else {
      console.log(`Current companion: ${configuration.summary}`);
      console.log(`Plan: ${plan.kind === 'chosen' ? `${plan.writeDefault ? 'set default to' : 'check'} ${plan.id}; ${modelIntent(plan.model)}` : plan.message || 'preserve configuration'}`);
      for (const report of Object.values(companions)) printCompanionReport(report);
    }
    process.exit(ok ? 0 : plan.kind === 'chosen' ? 3 : 2);
  }

  // Interactive companion selection when required and a tty is available.
  if (plan.kind === 'ask') {
    if (!process.stdin.isTTY) {
      console.error(`[FAIL] no --companion given and not a tty; pass --companion ${[...COMPANION_IDS].join('|')}|none.`);
      process.exit(2);
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    console.log('Select a companion:');
    for (const r of Object.values(companions)) printCompanionReport(r);
    const ans = (await rl.question(`\nCompanion [${plan.candidates.join('/')}/none]: `)).trim().toLowerCase();
    let model;
    if (companions[ans]?.capabilities.modelSelection) {
      const answer = (await rl.question(`Model for ${ans} [Enter keeps saved model, inherit clears it]: `)).trim();
      if (answer) model = answer;
    }
    rl.close();
    if (ans === 'none') plan = planOnboard({ options: { ...options, companion: ans }, companions, configuration });
    else if (COMPANION_IDS.has(ans)) plan = planOnboard({ options: { ...options, companion: ans, model, setDefault: true }, companions, configuration });
    else { console.error(`[FAIL] invalid selection: ${ans}`); process.exit(2); }
  }

  if (plan.kind === 'error') {
    console.error(`[FAIL] ${plan.code}: ${plan.message}`);
    process.exit(2);
  }

  if (plan.kind === 'host-only' || plan.kind === 'preserved') {
    const msg = `configuration preserved; companion: ${configuration.summary}.`;
    if (options.json) console.log(JSON.stringify({ ok: true, host: options.host, companion: null, wroteDefault: false,
      model: plan.model, configuration, note: msg }, null, 2));
    else console.log(`[OK] ${msg}`);
    process.exit(0);
  }

  // plan.kind === 'chosen'
  const { id, report } = plan;
  let wrote = false;
  let wroteModel = false;
  if (!options.json) {
    console.log(`Plan: ${plan.writeDefault ? 'set default to' : 'check'} ${id}; ${modelIntent(plan.model)}.`);
  }

  let smoke = null;
  if (options.smoke) {
    if (!report.ready) {
      smoke = { supported: false, passed: null, detail: 'companion not ready; skipping smoke.' };
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

  if (plan.writeDefault && (report.ready || options.noCompanionCheck) && smoke?.passed !== false) {
    if (readDefaultCompanion({ ...env, AGENT_COMPANION_DEFAULT_COMPANION: '' }).companion !== id) {
      writeDefaultCompanion(id);
      wrote = true;
    }
    if (plan.model.action === 'set') writeDefaultModel(plan.model.requested, id);
    if (plan.model.action === 'clear') clearDefaultModel(id);
    wroteModel = plan.model.action !== 'none';
    writeCompanionChecks(Object.fromEntries(Object.entries(companions).map(([id, check]) =>
      [id, { ...check, checkedAt: new Date().toISOString() }])));
  }
  const current = inspectConfiguration(readDefaultCompanion(env), companions);
  const defaultModel = readDefaultModel(id, env);
  const model = { ...plan.model, current: defaultModel.model, source: defaultModel.source };
  report.defaultModel = defaultModel;
  if (options.json) {
    console.log(JSON.stringify({ ok: report.ready && smoke?.passed !== false, host: options.host, companion: id, wroteDefault: wrote, model, autoSelected: !!plan.autoSelected, configuration: current, report, smoke }, null, 2));
  } else {
    if (plan.autoSelected) console.log(`[OK] auto-selected the only ready companion: ${id}`);
    printCompanionReport(report);
    if (wrote) console.log(`\n[OK] wrote default companion: ${id}`);
    if (wroteModel) console.log(plan.model.action === 'set' ? `[OK] wrote default model for ${id}: ${plan.model.requested}` : `[OK] cleared saved default model for ${id}`);
    if (!wrote && !wroteModel) console.log(`\n[INFO] configuration unchanged; companion: ${current.summary}.`);
    if (!report.ready && options.noCompanionCheck) console.log('[WARN] readiness deferred by --no-companion-check; companion is not ready.');
    if (!smoke) console.log('[INFO] live companion response remains unverified (no smoke requested).');
    if (smoke) console.log(`\nsmoke: ${smoke.supported ? (smoke.passed === null ? 'skipped' : smoke.passed ? 'passed' : 'failed') : 'unsupported'} — ${smoke.detail}`);
  }

  if (smoke?.passed === false || (!report.ready && !options.noCompanionCheck)) process.exit(3);
  process.exit(0);
}

// Only run the CLI when invoked directly, so tests can import the pure helpers.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch((err) => { console.error(`[FAIL] ${err.message}`); process.exit(1); });
}
