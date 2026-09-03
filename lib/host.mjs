// Host detection + per-host path resolution. Single source of truth for
// every place the companion has to choose between Claude Code and Codex CLI
// conventions (state directory, plans directory, agents directory, etc.).
//
// Authoritative source: the AGENT_COMPANION_HOST env var, set as a literal in
// each host's MCP registration. On Codex, .codex-plugin/plugin.json supplies
// AGENT_COMPANION_HOST = "codex" at plugin/session scope; the subagent inherits
// that server. Claude's agent-local registration relies on the default.
//
// Marker files at ~/.{claude,codex}/agent-companion/.host are diagnostic
// only — written at install time so a user can `cat ~/.codex/agent-companion/.host`
// to confirm what was installed where. They are NOT a fallback signal: with
// concurrent installs on both hosts, the fallback would be ambiguous.

import { homedir, tmpdir, userInfo } from 'node:os';
import { join, resolve, sep } from 'node:path';

const VALID_HOSTS = new Set(['claude', 'codex']);

let _cachedHost = null;

// Resolve the host once per process. Subsequent calls return the cached
// value — host doesn't change mid-process, and caching prevents repeated
// env reads in hot paths (every queue write looks up the host indirectly).
export function detectHost() {
  if (_cachedHost !== null) return _cachedHost;
  const raw = (process.env.AGENT_COMPANION_HOST || '').trim();
  _cachedHost = VALID_HOSTS.has(raw) ? raw : 'claude';
  return _cachedHost;
}

// Test-only escape hatch — clear the cache so a test that flips
// AGENT_COMPANION_HOST between cases observes the new value. Never call
// this in production code paths.
export function _resetHostCacheForTests() {
  _cachedHost = null;
}

function hostConfigDir(host) {
  if (host === 'codex') {
    const configured = String(process.env.CODEX_HOME || '').trim();
    if (configured) return resolve(configured);
  }
  return join(homedir(), `.${host}`);
}

// ~/.claude/agent-companion or $CODEX_HOME/agent-companion (default
// ~/.codex/agent-companion). The state
// layer (lib/state.mjs) and structured logger (lib/log.mjs) both root
// their files here.
export function companionHomeDir(host = detectHost()) {
  return join(hostConfigDir(host), 'agent-companion');
}

// The test-sandbox precondition. `node --test` sets NODE_TEST_CONTEXT in every
// test child and everything a test spawns inherits it, so "am I inside the
// suite?" is an environment fact, not a convention — and a path under the
// operator's REAL account home (os.userInfo(), which ignores a sandboxed $HOME)
// is one no test may use. Measured 2026-08-28: a hook suite that forgot to
// sandbox wrote fixture heartbeats into the real runtime dir on every run and
// kept the shared codex broker's idle reaper extended for 30 min each time. A
// textual guard over the test files was tried first and had four holes
// (directory allowlist, hooks that reach state through node, comment
// stripping, unchecked sandbox values); this closes all of them at the two
// choke points every caller goes through — `runtimeDir()` and state's
// BASE_DIR — plus the one bash hook that derives the path itself. A sandbox
// under os.tmpdir() is always allowed, even when TMPDIR lives under $HOME.
// Outside the suite this is a no-op.
export function refuseRealHomeUnderTest(dir, what) {
  if (!process.env.NODE_TEST_CONTEXT || !dir) return dir;
  let realHome = null;
  try { realHome = userInfo().homedir || null; } catch { /* no passwd entry: nothing to compare against */ }
  if (!realHome) return dir;
  const within = (base) => dir === base || dir.startsWith(base + sep);
  if (!within(realHome) || within(tmpdir())) return dir;
  throw new Error(
    `agent: refusing to use the operator's real ${what} (${dir}) from inside \`node --test\` — `
    + 'sandbox it first (AGENT_RUNTIME_DIR / AGENT_COMPANION_HOME, or HOME) so the suite cannot write into live state',
  );
}

// Plans directory used by template_args.plan_path="latest" resolution.
// Mirrors Claude's existing convention but adapted per-host.
export function plansDir(host = detectHost()) {
  return join(hostConfigDir(host), 'plans');
}

// Where the host materializes agent definitions. Claude reads
// ~/.claude/agents/<name>.md; Codex reads ~/.codex/agents/<name>.toml.
export function agentsDir(host = detectHost()) {
  return join(hostConfigDir(host), 'agents');
}

// Path to the host's user-scope settings file.
//   - Claude: ~/.claude/settings.json (permissions allow-list lives here)
//   - Codex: ~/.codex/config.toml (TOML, not JSON — caller must use the
//     right parser; we only return the path)
export function settingsFile(host = detectHost()) {
  if (host === 'codex') return join(hostConfigDir(host), 'config.toml');
  return join(hostConfigDir(host), 'settings.json');
}

// The host-side env var (if any) carrying the session id. Claude exposes
// CLAUDE_CODE_SESSION_ID; Codex passes the session id through MCP _meta
// rather than an env var — this helper still returns a stable name for
// docs/diagnostics, but the bridge prefers MCP _meta for Codex.
export function sessionIdEnvVar(host = detectHost()) {
  return host === 'codex' ? 'CODEX_SESSION_ID' : 'CLAUDE_CODE_SESSION_ID';
}

// Sanitize a host session id so it's safe to use as a filename component.
// lib/state.mjs's threadPath validator only allows [a-zA-Z0-9._-]+; Codex
// session ids look like UUIDv7 strings (e.g., "019e0dc8-94b3-7172-..." — all
// chars in the allowlist), but if a future host returns a session id with
// other characters this helper guarantees we never throw at file-write time.
// Replaces every disallowed run with a single underscore.
export function sanitizeHostSessionId(sid) {
  if (!sid || typeof sid !== 'string') return '';
  return sid.replace(/[^a-zA-Z0-9._-]+/g, '_');
}
