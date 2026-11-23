import { tmpdir, userInfo } from 'node:os';
import { join, sep } from 'node:path';
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
// env reads in hot paths (every queue write looks up the host indirectly).
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

// The test-sandbox precondition. `node --test` sets NODE_TEST_CONTEXT in every
// test child and everything a test spawns inherits it, so "am I inside the
// suite?" is an environment fact, not a convention — and a path under the
// operator's REAL account home (os.userInfo(), which ignores a sandboxed $HOME)
// is one no test may use. Measured 2026-08-28: a hook suite that forgot to
// sandbox wrote fixture heartbeats into the real runtime dir on every run and
// kept the retired shared codex broker's idle reaper extended for 30 min each time. A
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
