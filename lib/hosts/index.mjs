export { refuseRealHomeUnderTest } from './runtime.mjs';
import { join } from 'node:path';
import { claude } from './claude.mjs';
import { codex } from './codex.mjs';

// AGENT_COMPANION_HOST in the host's MCP registration is authoritative.
// Install markers are diagnostic, including when both hosts are installed.
export const HOSTS = Object.fromEntries([claude, codex].map(host => [host.id, {
  ...host,
  stateDir: env => join(host.configDir(env), 'agent-companion'),
  settingsFile: env => join(host.configDir(env), host.settingsName),
}]));

export function settingsFile(host = detectHost()) {
  return HOSTS[host].settingsFile();
}

let _cachedHost = null;

function hostFromEnv(env) {
  const raw = (env.AGENT_COMPANION_HOST || '').trim();
  return Object.hasOwn(HOSTS, raw) ? raw : claude.id;
}

// Resolve the host once per process. Subsequent calls return the cached
// value — host doesn't change mid-process, and caching prevents repeated
// env reads in hot paths.
export function detectHost() {
  if (_cachedHost !== null) return _cachedHost;
  _cachedHost = hostFromEnv(process.env);
  return _cachedHost;
}

// Test-only escape hatch — clear the cache so a test that flips
// AGENT_COMPANION_HOST between cases observes the new value. Never call
// this in production code paths.
export function _resetHostCacheForTests() {
  _cachedHost = null;
}

// ~/.claude/agent-companion or $CODEX_HOME/agent-companion (default
// ~/.codex/agent-companion): the state layer and logs root their files here.
export function companionHomeDir(host = detectHost(), env = process.env) {
  return HOSTS[host].stateDir(env);
}

// Cross-host settings migration and views share the same state roots.
export function stateDirs(env = process.env) {
  if (env.AGENT_COMPANION_HOME) return [{ host: env === process.env ? detectHost() : hostFromEnv(env), dir: env.AGENT_COMPANION_HOME }];
  return Object.values(HOSTS).map(host => ({ host: host.id, dir: host.stateDir(env) }));
}
