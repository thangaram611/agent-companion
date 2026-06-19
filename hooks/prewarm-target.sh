#!/bin/bash
# prewarm-target.sh — SessionStart hook
#
# Target-aware prewarm. The only target with a daemon to warm is Copilot (its
# ACP daemon). Pre-spawning it at session start means the first delegation
# call doesn't pay the daemon-spawn latency that otherwise surfaces as
# "bridge_daemon_unreachable" when the daemon is cold.
#
# This runs ONLY when the configured default target resolves to `copilot`.
# OpenCode has no daemon (single-shot CLI), and an unconfigured target means
# onboarding hasn't chosen one yet — in both cases we do nothing and let the
# bridge lazy-start whatever the first send needs.
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
