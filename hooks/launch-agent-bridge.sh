#!/bin/bash
# Codex plugin MCP launcher.
#
# Codex intentionally does not let an agent role add MCP servers that its
# parent did not have. The Codex-only plugin manifest therefore registers the
# bridge at session scope, and the agent role inherits it. This launcher keeps
# that registration independent of a GUI process's PATH and makes a first run
# wait for the bridge dependencies instead of racing the SessionStart hook.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)" || exit 1
PLUGIN_PACKAGE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)" || exit 1
CODEX_DATA_ROOT="${CODEX_HOME:-$HOME/.codex}"

# Legacy Codex plugins do not receive the Agent Plugins PLUGIN_DATA overlay.
# Use Codex's documented cache-independent data layout for this fixed plugin
# id so this launcher and the SessionStart installer converge on one install.
export PLUGIN_ROOT="$PLUGIN_PACKAGE_ROOT"
export PLUGIN_DATA="${PLUGIN_DATA:-$CODEX_DATA_ROOT/plugins/data/agent-companion-agent-companion}"
export AGENT_COMPANION_HOST="codex"

# stdout belongs exclusively to MCP framing. Dependency notices and failures
# must go to stderr or they corrupt the protocol before initialize.
# A SessionStart hook may already hold the dependency-install lock. That hook's
# normal contended path exits successfully after its bounded wait even when the
# install has not finished yet, because hook banners must not report a false
# failure. MCP startup has a stronger contract: do not exec the server until its
# primary SDK is actually resolvable. Two bounded install attempts remain below
# the manifest's 120s startup timeout and let an in-flight installer finish.
DEPS_READY=0
for _attempt in 1 2; do
  CLAUDE_PLUGIN_ROOT="$PLUGIN_PACKAGE_ROOT" \
    AGENT_COMPANION_REQUIRE_DEPS=1 \
    /bin/bash "$PLUGIN_PACKAGE_ROOT/hooks/install-deps.sh" >&2
  INSTALL_STATUS=$?
  if [ "$INSTALL_STATUS" -eq 75 ]; then
    continue
  fi
  if [ "$INSTALL_STATUS" -ne 0 ]; then
    exit 1
  fi
  # The same file install-deps.sh's `installed_ok` requires before it calls the
  # managed install current: keep the two spelled identically.
  SDK_PACKAGE="$PLUGIN_PACKAGE_ROOT/bridge-server/node_modules/@modelcontextprotocol/sdk/package.json"
  if [ -r "$SDK_PACKAGE" ]; then
    DEPS_READY=1
    break
  fi
done
if [ "$DEPS_READY" -ne 1 ]; then
  echo "agent-companion: bridge dependencies are not ready after two bounded install attempts" >&2
  exit 1
fi

TOOLS="$PLUGIN_PACKAGE_ROOT/hooks/node-tools.sh"
[ -r "$TOOLS" ] || {
  echo "agent-companion: missing Node resolver: $TOOLS" >&2
  exit 1
}
# shellcheck source=/dev/null
. "$TOOLS"
NODE_BIN="$(resolve_node 2>/dev/null || true)"
[ -n "$NODE_BIN" ] || {
  echo "agent-companion: Node.js 22 or newer is required" >&2
  exit 1
}

exec "$NODE_BIN" "$PLUGIN_PACKAGE_ROOT/bridge-server/server.mjs"
