// The one synchronous command probe used by bridge-side diagnostics and
// preflight checks. Keep this module dependency-free: installation inspection
// runs during broker boot, including in tests that must not initialize the
// operator's state directory merely to execute `codex --version`.

import { execFileSync } from 'node:child_process';

export const PROBE_TIMEOUT_MS = 120_000;

export function probeCommand(cmd, args = [], { timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  try {
    return {
      ok: true,
      output: execFileSync(cmd, args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: timeoutMs,
        // A catchable signal does not bound a child that ignores it: the sync
        // call keeps waiting after delivering the signal.
        killSignal: 'SIGKILL',
      }).trim(),
    };
  } catch (err) {
    if (err.code === 'ETIMEDOUT') {
      return { ok: false, timedOut: true, output: `\`${cmd}\` did not respond within ${timeoutMs}ms and was killed` };
    }
    return { ok: false, output: String(err.stderr || err.message || '').trim() };
  }
}
