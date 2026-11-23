#!/usr/bin/env node
// Remove user-scope hook entries left by older source installs.
// Usage: node scripts/install-codex-hooks.mjs --plugin-root /abs/path --uninstall
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

const configuredCodexHome = String(process.env.CODEX_HOME || '').trim();
const CODEX_HOME = configuredCodexHome
  ? path.resolve(configuredCodexHome)
  : path.join(homedir(), '.codex');
const HOOKS_FILE = path.join(CODEX_HOME, 'hooks.json');
const SENTINEL_KEY = '_managed_by';
const SENTINEL_VALUE = 'agent-companion';
const args = process.argv.slice(2);
const rootIdx = args.indexOf('--plugin-root');
const pluginRoot = rootIdx >= 0 ? args[rootIdx + 1] : null;

const ok = (m) => console.log(`[OK]   ${m}`);
const fail = (m, code = 1) => {
  console.error(`[FAIL] ${m}`);
  process.exit(code);
};

if (!pluginRoot) {
  fail('--plugin-root <abs path> required; pass the directory containing .codex-plugin/plugin.json', 2);
}
if (!path.isAbsolute(pluginRoot)) {
  fail(`--plugin-root must be absolute (got: ${pluginRoot})`, 2);
}

if (!args.includes('--uninstall')) fail('--uninstall required', 2);

mkdirSync(path.dirname(HOOKS_FILE), { recursive: true });

let cfg = {};
if (existsSync(HOOKS_FILE)) {
  let raw;
  try {
    raw = readFileSync(HOOKS_FILE, 'utf8');
  } catch (e) {
    fail(`cannot read ${HOOKS_FILE}: ${e.message}`, 2);
  }
  // Empty file is OK — treat as fresh config.
  if (raw.trim().length > 0) {
    try {
      cfg = JSON.parse(raw);
    } catch (e) {
      fail(
        `${HOOKS_FILE} is not valid JSON: ${e.message}. Fix manually (or move it aside) before re-running so we don't overwrite your data.`,
        2,
      );
    }
    if (cfg === null || typeof cfg !== 'object' || Array.isArray(cfg)) {
      fail(`${HOOKS_FILE} top-level must be a JSON object`, 2);
    }
  }
}

if (!cfg.hooks || typeof cfg.hooks !== 'object' || Array.isArray(cfg.hooks)) {
  cfg.hooks = {};
}

// Drop every entry whose top-level _managed_by === SENTINEL_VALUE.
function dropManaged(eventName) {
  const list = cfg.hooks[eventName];
  if (!Array.isArray(list)) return false;
  const filtered = list.filter((entry) => {
    return !entry || entry[SENTINEL_KEY] !== SENTINEL_VALUE;
  });
  if (filtered.length === list.length) return false;
  if (filtered.length === 0) {
    delete cfg.hooks[eventName];
  } else {
    cfg.hooks[eventName] = filtered;
  }
  return true;
}

const ALL_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PreToolUse', 'Stop'];

let removed = false;
for (const ev of ALL_EVENTS) {
  if (dropManaged(ev)) removed = true;
}
if (!removed) {
  ok(`no agent-companion hooks present in ${HOOKS_FILE}`);
  process.exit(0);
}
if (Object.keys(cfg.hooks).length === 0) delete cfg.hooks;
writeAtomic(cfg);
ok(`removed agent-companion hooks from ${HOOKS_FILE}`);

function writeAtomic(data) {
  const ts = new Date()
    .toISOString()
    .replace(/[-:T.]/g, '')
    .slice(0, 14);
  const hadExisting = existsSync(HOOKS_FILE);
  if (hadExisting) {
    const backup = `${HOOKS_FILE}.bak.${ts}`;
    copyFileSync(HOOKS_FILE, backup);
    console.log(`[INFO] backup: ${backup}`);
  }
  const tmp = `${HOOKS_FILE}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, HOOKS_FILE);
}
