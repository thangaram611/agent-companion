#!/usr/bin/env node
// install-codex-hooks.mjs — idempotently install the agent-companion
// hook entries into ~/.codex/hooks.json for source-checkout development.
// A finalized marketplace package can move these hooks into plugin scope; this
// script exists so a local checkout can exercise the same lifecycle without
// requiring a publish/install round trip.
//
// Why a script instead of just shipping hooks/hooks-codex.json: the user
// almost certainly has other hooks already in place (their own
// PreToolUse/PostToolUse scripts, other plugins' entries). Overwriting
// would destroy unrelated work. Also, user-scope hook commands cannot
// reference ${CLAUDE_PLUGIN_ROOT}. We substitute the absolute plugin path at
// install time, which only this script knows.
//
// Usage:
//   node scripts/install-codex-hooks.mjs --plugin-root /abs/path [--yes]
//   node scripts/install-codex-hooks.mjs --plugin-root /abs/path --uninstall
//
// Behavior:
//   - Backs up ~/.codex/hooks.json to ~/.codex/hooks.json.bak.<ts> when
//     it exists and would be modified.
//   - Each managed entry carries `_managed_by: "agent-companion"` so
//     uninstall and re-install can locate just our entries without
//     touching unrelated work.
//   - Aborts cleanly if the existing file is not valid JSON (rather than
//     overwriting and losing the user's data).
//
// Exit codes: 0 success / no-op, 1 user-aborted or non-tty without --yes,
// 2 malformed hooks.json or other fatal fs/parse error.

import {
  existsSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  mkdirSync,
  renameSync,
  accessSync,
  constants,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';

const HOOKS_FILE = path.join(homedir(), '.codex', 'hooks.json');
const SENTINEL_KEY = '_managed_by';
const SENTINEL_VALUE = 'agent-companion';
const STABLE_HOOK_PATH_DIRS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
];

const args = process.argv.slice(2);
const yes = args.includes('--yes') || args.includes('-y');
const uninstall = args.includes('--uninstall');
const rootIdx = args.indexOf('--plugin-root');
const pluginRoot = rootIdx >= 0 ? args[rootIdx + 1] : null;

const ok = (m) => console.log(`[OK]   ${m}`);
const fail = (m, code = 1) => {
  console.error(`[FAIL] ${m}`);
  process.exit(code);
};

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

if (!pluginRoot) {
  fail('--plugin-root <abs path> required; pass the directory containing .codex-plugin/plugin.json', 2);
}
if (!path.isAbsolute(pluginRoot)) {
  fail(`--plugin-root must be absolute (got: ${pluginRoot})`, 2);
}

// Hook definitions to install. Each command resolves to an absolute path
// at install time — Codex does NOT expand ${CLAUDE_PLUGIN_ROOT} for
// user-scope hooks (only for plugin-scope hooks discovered through
// append_plugin_hook_sources). We export the var explicitly in the
// command line so the underlying scripts (which still reference
// $CLAUDE_PLUGIN_ROOT internally) can resolve their own paths.
function scriptPath(scriptRel) {
  return path.join(pluginRoot, scriptRel);
}

function buildHookPath(nodeDir) {
  const seen = new Set();
  const entries = [
    nodeDir,
    ...STABLE_HOOK_PATH_DIRS,
  ].filter(Boolean);
  const out = [];
  for (const entry of entries) {
    if (seen.has(entry)) continue;
    seen.add(entry);
    out.push(entry);
  }
  return out.join(path.delimiter);
}

function findExecutable(name, searchDirs) {
  const candidates = searchDirs
    .filter(Boolean)
    .map((dir) => path.join(dir, name));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

function bashEntry(scriptRel, timeout) {
  const abs = scriptPath(scriptRel);
  const nodeDir = path.dirname(process.execPath);
  const hookPath = buildHookPath(nodeDir);
  const npmBin = findExecutable('npm', [nodeDir, ...STABLE_HOOK_PATH_DIRS]);
  const jqBin = findExecutable('jq', STABLE_HOOK_PATH_DIRS);
  const env = [
    `CLAUDE_PLUGIN_ROOT=${shellQuote(pluginRoot)}`,
    'AGENT_COMPANION_HOST=codex',
    `AGENT_COMPANION_NODE=${shellQuote(process.execPath)}`,
  ];
  if (npmBin) env.push(`AGENT_COMPANION_NPM=${shellQuote(npmBin)}`);
  if (jqBin) env.push(`AGENT_COMPANION_JQ=${shellQuote(jqBin)}`);
  env.push(`PATH=${shellQuote(hookPath)}`);
  return {
    type: 'command',
    command: `${env.join(' ')} /bin/bash ${shellQuote(abs)}`,
    timeout,
    [SENTINEL_KEY]: SENTINEL_VALUE,
  };
}

const MANAGED_ENTRIES = {
  SessionStart: [
    {
      hooks: [
        bashEntry('hooks/install-agent-codex.sh', 5),
        bashEntry('hooks/prewarm-target.sh', 5),
        bashEntry('hooks/install-deps.sh', 55),
        bashEntry('hooks/drain-completions.sh', 5),
      ],
      [SENTINEL_KEY]: SENTINEL_VALUE,
    },
  ],
  UserPromptSubmit: [
    {
      hooks: [bashEntry('hooks/drain-completions.sh', 5)],
      [SENTINEL_KEY]: SENTINEL_VALUE,
    },
  ],
  PostToolUse: [
    {
      matcher: '.*',
      hooks: [bashEntry('hooks/drain-completions.sh', 5)],
      [SENTINEL_KEY]: SENTINEL_VALUE,
    },
  ],
};

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
  if (!Array.isArray(list)) return;
  const filtered = list.filter((entry) => {
    return !entry || entry[SENTINEL_KEY] !== SENTINEL_VALUE;
  });
  if (filtered.length === 0) {
    delete cfg.hooks[eventName];
  } else {
    cfg.hooks[eventName] = filtered;
  }
}

const ALL_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PreToolUse', 'Stop'];

if (uninstall) {
  for (const ev of ALL_EVENTS) dropManaged(ev);
  if (Object.keys(cfg.hooks).length === 0) delete cfg.hooks;
  writeAtomic(cfg);
  ok(`removed agent-companion hooks from ${HOOKS_FILE}`);
  process.exit(0);
}

// Confirm with the user before mutating an existing file (skipped with --yes).
if (existsSync(HOOKS_FILE) && !yes) {
  if (!process.stdin.isTTY) {
    fail('interactive confirmation required but stdin is not a tty; pass --yes', 1);
  }
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const ans = (await rl.question(`Merge agent-companion hooks into ${HOOKS_FILE}? [y/N] `))
    .trim()
    .toLowerCase();
  rl.close();
  if (ans !== 'y' && ans !== 'yes') {
    console.log('aborted');
    process.exit(1);
  }
}

// Replace any prior managed entries (idempotent re-install) before
// merging the fresh ones.
for (const ev of ALL_EVENTS) dropManaged(ev);

// Merge: append managed entries to each event's existing array. We
// deliberately keep ours as separate sibling entries (rather than
// folding into the user's existing matcher entries) so uninstall is a
// clean filter operation.
for (const [ev, entries] of Object.entries(MANAGED_ENTRIES)) {
  if (!Array.isArray(cfg.hooks[ev])) cfg.hooks[ev] = [];
  cfg.hooks[ev].push(...entries);
}

writeAtomic(cfg);
ok(`installed agent-companion hooks into ${HOOKS_FILE}`);

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
