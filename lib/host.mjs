// Host detection + per-host path resolution. Single source of truth for
// every place the companion has to choose between Claude Code and Codex CLI
// conventions (state directory, plans directory, agents directory, etc.).
//
// Authoritative source: the AGENT_COMPANION_HOST env var, set as a literal
// string in each host's per-plugin MCP server config. On Codex, the
// materialized agent TOML's [mcp_servers.agent-bridge.env] table writes
// AGENT_COMPANION_HOST = "codex" — Codex MCP env values are literals (no
// ${VAR} expansion), so the bridge always sees the right value at spawn.
// Claude installs do not inject the env var; they rely on the default.
//
// Marker files at ~/.{claude,codex}/agent-companion/.host are diagnostic
// only — written at install time so a user can `cat ~/.codex/agent-companion/.host`
// to confirm what was installed where. They are NOT a fallback signal: with
// concurrent installs on both hosts, the fallback would be ambiguous.

import { homedir } from 'node:os';
import { join } from 'node:path';

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

// ~/.claude/agent-companion or ~/.codex/agent-companion. The state
// layer (lib/state.mjs) and structured logger (lib/log.mjs) both root
// their files here.
export function companionHomeDir(host = detectHost()) {
  return join(homedir(), `.${host}`, 'agent-companion');
}

// Plans directory used by template_args.plan_path="latest" resolution.
// Mirrors Claude's existing convention but adapted per-host.
export function plansDir(host = detectHost()) {
  return join(homedir(), `.${host}`, 'plans');
}

// Where the host materializes agent definitions. Claude reads
// ~/.claude/agents/<name>.md; Codex reads ~/.codex/agents/<name>.toml.
export function agentsDir(host = detectHost()) {
  return join(homedir(), `.${host}`, 'agents');
}

// Path to the host's user-scope settings file.
//   - Claude: ~/.claude/settings.json (permissions allow-list lives here)
//   - Codex: ~/.codex/config.toml (TOML, not JSON — caller must use the
//     right parser; we only return the path)
export function settingsFile(host = detectHost()) {
  if (host === 'codex') return join(homedir(), '.codex', 'config.toml');
  return join(homedir(), '.claude', 'settings.json');
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
