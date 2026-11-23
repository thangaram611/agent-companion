#!/usr/bin/env node
// install-permissions.mjs — idempotently grant the agent-companion Claude
// permissions in ~/.claude/settings.json. Pure Node ≥20 (no jq dependency);
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
import { tools } from '../bridge-server/tools.mjs';
import { HOSTS, settingsFile } from '../lib/hosts/index.mjs';
import path from 'node:path';
import readline from 'node:readline/promises';

// Claude registers the bridge at plugin scope, so the tool names carry the
// plugin namespace. Both namespaces can contain permissions from the old tool set.
const STALE = /^mcp__(?:plugin_agent-companion_)?agent-bridge__agent_/;
const args = process.argv.slice(2);
const yes = args.includes('--yes') || args.includes('-y');

const hostIdx = args.indexOf('--host');
const host = hostIdx >= 0 ? args[hostIdx + 1] : HOSTS.claude.id;
if (!Object.hasOwn(HOSTS, host)) {
  console.error(`[FAIL] --host must be ${Object.keys(HOSTS).map(id => `'${id}'`).join(' or ')} (got: ${host})`);
  process.exit(2);
}

const ok = (m) => console.log(`[OK]   ${m}`);
const fail = (m, code = 1) => {
  console.error(`[FAIL] ${m}`);
  process.exit(code);
};

// Only Claude consumes these allow-list entries.
if (!HOSTS[host].permissionAllowList) {
  ok(`permission injection skipped: ${HOSTS[host].displayName} manages its own tool permissions`);
  process.exit(0);
}

const SETTINGS = settingsFile(host);
const PERMISSIONS = tools.map(({ name }) => HOSTS[host].toolPrefix + name);
const isStale = p => STALE.test(p) || p === 'Agent(agent-companion)';
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

const stale = allow.filter(isStale);
const kept = allow.filter((permission) => !isStale(permission));
const missing = PERMISSIONS.filter((permission) => !kept.includes(permission));
if (missing.length === 0 && stale.length === 0) {
  ok(`agent-companion permissions already in ${SETTINGS}`);
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
  const ans = (await rl.question(`Add ${missing.length} agent-companion permission(s) and remove ${stale.length} stale one(s) in ${SETTINGS}? [y/N] `))
    .trim()
    .toLowerCase();
  rl.close();
  if (ans !== 'y' && ans !== 'yes') {
    console.log('aborted');
    process.exit(1);
  }
}

cfg.permissions.allow = kept.concat(missing);

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
ok(`added ${missing.join(', ') || 'nothing'}${stale.length ? `; removed stale ${stale.join(', ')}` : ''}${hadExisting ? ` (backup: ${backup})` : ''}`);
