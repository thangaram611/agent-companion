#!/usr/bin/env node
// install-permissions.mjs — idempotently grant the copilot-bridge MCP tools
// permission in ~/.claude/settings.json. Pure Node ≥20 (no jq dependency);
// relies only on the Node version setup.sh already verifies.
//
// Usage:
//   node scripts/install-permissions.mjs                   # interactive y/N (Claude)
//   node scripts/install-permissions.mjs --yes             # non-interactive (Claude, used by setup.sh)
//   node scripts/install-permissions.mjs --host codex      # no-op (see below)
//
// Why --host codex is a no-op: Codex's permission/approval model is
// fundamentally different (sandbox modes, trust levels, per-project
// trust_level entries) and doesn't read a per-MCP-tool allow-list out
// of any user-scope file we control. Injecting permissions is therefore
// out of scope for this script. Setup.sh delegates to it for both hosts
// to keep the flow uniform; the codex branch logs a noop and exits 0.
//
// Exit codes: 0 success / already present / codex no-op, 1 user-aborted or
// non-tty without --yes, 2 malformed settings.json (parse error or wrong shape).

import {
  existsSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  mkdirSync,
  renameSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';

const TOOLS = [
  'mcp__copilot-bridge__copilot_send',
  'mcp__copilot-bridge__copilot_wait',
  'mcp__copilot-bridge__copilot_status',
  'mcp__copilot-bridge__copilot_reply',
  'mcp__copilot-bridge__copilot_cancel',
];
const SETTINGS = path.join(homedir(), '.claude', 'settings.json');
const args = process.argv.slice(2);
const yes = args.includes('--yes') || args.includes('-y');

const hostIdx = args.indexOf('--host');
const host = hostIdx >= 0 ? args[hostIdx + 1] : 'claude';
if (host !== 'claude' && host !== 'codex') {
  console.error(`[FAIL] --host must be 'claude' or 'codex' (got: ${host})`);
  process.exit(2);
}

const ok = (m) => console.log(`[OK]   ${m}`);
const fail = (m, code = 1) => {
  console.error(`[FAIL] ${m}`);
  process.exit(code);
};

// Codex permission model is not addressed by this plan — emit a clear
// no-op marker so setup.sh's exit-code check stays happy and a future
// Codex-permission implementation has an obvious place to plug in.
if (host === 'codex') {
  ok('permission injection skipped: Codex permission model not handled by this plan');
  process.exit(0);
}

mkdirSync(path.dirname(SETTINGS), { recursive: true });

let cfg = {};
if (existsSync(SETTINGS)) {
  let raw;
  try {
    raw = readFileSync(SETTINGS, 'utf8');
  } catch (e) {
    fail(`cannot read ${SETTINGS}: ${e.message}`, 2);
  }
  try {
    cfg = JSON.parse(raw);
  } catch (e) {
    fail(`${SETTINGS} is not valid JSON: ${e.message}. Fix manually before re-running.`, 2);
  }
  if (cfg === null || typeof cfg !== 'object' || Array.isArray(cfg)) {
    fail(`${SETTINGS} top-level must be a JSON object`, 2);
  }
}

if (
  !cfg.permissions ||
  typeof cfg.permissions !== 'object' ||
  Array.isArray(cfg.permissions)
) {
  cfg.permissions = {};
}
const allow = Array.isArray(cfg.permissions.allow)
  ? cfg.permissions.allow.slice()
  : [];

const missing = TOOLS.filter((tool) => !allow.includes(tool));
if (missing.length === 0) {
  ok(`copilot-bridge MCP tools already in ${SETTINGS}`);
  process.exit(0);
}

if (!yes && !process.stdin.isTTY) {
  fail('interactive confirmation required but stdin is not a tty; pass --yes', 1);
}

if (!yes) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const ans = (await rl.question(`Add ${missing.length} copilot-bridge MCP tool permission(s) to ${SETTINGS}? [y/N] `))
    .trim()
    .toLowerCase();
  rl.close();
  if (ans !== 'y' && ans !== 'yes') {
    console.log('aborted');
    process.exit(1);
  }
}

allow.push(...missing);
cfg.permissions.allow = allow;

const ts = new Date()
  .toISOString()
  .replace(/[-:T.]/g, '')
  .slice(0, 14);
const backup = `${SETTINGS}.bak.${ts}`;
const hadExisting = existsSync(SETTINGS);
if (hadExisting) copyFileSync(SETTINGS, backup);
const tmp = `${SETTINGS}.tmp.${process.pid}`;
writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
renameSync(tmp, SETTINGS);
ok(`added ${missing.join(', ')}${hadExisting ? ` (backup: ${backup})` : ''}`);
