import { tmpdir, userInfo } from 'node:os';
import { join, sep } from 'node:path';

// NODE_TEST_CONTEXT reaches every child of node --test. Compare the account
// home (independent of a fixture's HOME) and allow sandboxes under tmpdir().
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

// A status check can resolve a path without creating the runtime directory.
export function runtimeRoot(host, env) {
  return refuseRealHomeUnderTest(env.AGENT_RUNTIME_DIR || join(host.configDir(env), 'agent-companion', 'runtime'), 'runtime dir');
}
