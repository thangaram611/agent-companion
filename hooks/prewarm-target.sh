#!/bin/bash
# prewarm-target.sh — SessionStart hook
#
# Target-aware prewarm. Copilot is the only target this hook warms: pre-spawning
# its ACP daemon at session start means the first delegation call doesn't pay the
# daemon-spawn latency that otherwise surfaces as "bridge_daemon_unreachable"
# when the daemon is cold.
#
# It is NOT the only target with a long-lived process any more — OpenCode's
# `server` adapter drives a detached `opencode serve`, and Codex's `appserver`
# adapter is backed by a detached broker. Neither is warmed here, and that is a
# scoping choice rather than an absence: both are opt-in transports selected per
# job by an env var the hook cannot see at session start, whereas Copilot's
# daemon is unconditional for a copilot-default install. Their cold-start cost is
# real and is simply paid on first dispatch.
#
# So the three cases this hook sees:
#   copilot  — prewarm the ACP daemon (below).
#   opencode — default `cli` transport is single-shot with nothing to warm;
#              `server` is opt-in and warmed lazily.
#   codex    — default `exec` transport is single-shot with nothing to warm;
#              `appserver` is opt-in and warmed lazily.
# An unconfigured target means onboarding hasn't chosen one yet. In every
# non-copilot case we do nothing and let the bridge lazy-start what the first
# send needs.
#
# Idempotent: ensureDaemon() probes the socket first and only spawns when no
# healthy daemon answers. Non-fatal: any failure here falls back to the bridge's
# lazy ensureDaemon() at first MCP call. Backgrounded with nohup + disown so
# session start never waits on it.
#
# Safe to run before install-deps.sh: daemon-client.mjs, state.mjs, and the
# daemon itself only use Node built-ins — no bare imports — so they don't need
# bridge-server/node_modules to be present.

ROOT="${CLAUDE_PLUGIN_ROOT:-${PLUGIN_ROOT:-}}"
[ -n "$ROOT" ] || exit 0

CLIENT="$ROOT/bridge-server/daemon-client.mjs"
[ -f "$CLIENT" ] || exit 0

TOOLS="$ROOT/hooks/node-tools.sh"
if [ -r "$TOOLS" ]; then
  # shellcheck source=/dev/null
  . "$TOOLS"
fi
NODE_BIN="$(resolve_node 2>/dev/null || true)"
[ -n "$NODE_BIN" ] || exit 0

# Resolve the configured default target (env override → state file → unset).
# Only Copilot has a daemon to prewarm.
TARGET="$("$NODE_BIN" -e "
import('$ROOT/lib/state.mjs')
  .then((m) => { process.stdout.write(m.readDefaultTarget().target || ''); })
  .catch(() => {});
" 2>/dev/null)"

[ "$TARGET" = "copilot" ] || exit 0

cd "$ROOT/bridge-server" 2>/dev/null || exit 0

nohup "$NODE_BIN" -e "
import('./daemon-client.mjs')
  .then((m) => m.ensureDaemon({}))
  .catch(() => {});
" >/dev/null 2>&1 &
disown 2>/dev/null || true

exit 0
