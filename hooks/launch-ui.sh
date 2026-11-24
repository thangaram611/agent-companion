#!/bin/bash
# Target of the `agent-companion` launcher that setup.sh installs in
# ~/.local/bin. Runs the read-only UI from this plugin root with a Node 26
# resolved the way the hooks resolve it. Dependencies are read where this root
# keeps them, never installed here: bridge-server/node_modules (a source
# checkout: setup's npm ci, or Claude's link into its plugin data), else Codex's
# plugin data, resolved as the bridge resolves its SDK there, because a Codex
# plugin bundle contains no node_modules.

# Help also works before the UI dependencies are installed.
case "${1:-}:${2:-}" in
  --help:|-h:|help:)
    cat <<'HELP'
usage: agent-companion ui | defaults | jobs | follow | send

  ui        Browse companion jobs across configured hosts
  defaults  Inspect or change companion defaults
Claude pane helpers:
  jobs      List jobs for a session
  follow    Follow a job transcript
  send      Submit a message or cancel a job
HELP
    exit 0 ;;
  ui:--help) echo 'usage: agent-companion ui   Browse jobs across configured hosts. Press ? for keys.'; exit 0 ;;
  defaults:--help) echo 'usage: agent-companion defaults [companion=<id> | <companion> [model=<id>|model=inherit] [effort=<level>|effort=inherit]] [--json]'; exit 0 ;;
  jobs:--help) echo 'usage: agent-companion jobs <state dir> <session id> <limit>'; exit 0 ;;
  follow:--help) echo 'usage: agent-companion follow <state dir> <job id>'; exit 0 ;;
  send:--help) echo 'usage: agent-companion send <state dir> <job id> <steer|queue|interrupt|cancel> [text]'; exit 0 ;;
esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)" || exit 1
ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)" || exit 1

# shellcheck source=hooks/node-tools.sh
. "$ROOT/hooks/node-tools.sh"
NODE_BIN="$(resolve_node 2>/dev/null || true)"
if [ -z "$NODE_BIN" ]; then
  node_requirement_error
  exit 1
fi

# Claude Code's Companions pane follows one job through `follow`, lists its
# session's jobs through `jobs` and sends a message or cancel through `send`;
# none imports packages.
case "${1:-}" in
  defaults) shift; exec "$NODE_BIN" "$ROOT/bridge-server/ui/defaults.mjs" "$@" ;;
  follow) shift; exec "$NODE_BIN" "$ROOT/bridge-server/ui/follow.mjs" "$@" ;;
  jobs) shift; exec "$NODE_BIN" "$ROOT/bridge-server/ui/jobs.mjs" "$@" ;;
  send) shift; exec "$NODE_BIN" "$ROOT/bridge-server/ui/inbox.mjs" "$@" ;;
esac

UI="$ROOT/bridge-server/ui/app.mjs"
if [ -r "$ROOT/bridge-server/node_modules/ink/package.json" ]; then
  exec "$NODE_BIN" "$UI" "$@"
fi
. "$SCRIPT_DIR/host-paths.sh" || exit 1
host_paths codex "$ROOT"
if [ -r "$HOST_PLUGIN_DATA/bridge-server/node_modules/ink/package.json" ]; then
  PLUGIN_DATA="$HOST_PLUGIN_DATA" exec "$NODE_BIN" --import "$HOST_BRIDGE_IMPORT" "$UI" "$@"
fi
echo "agent-companion: the UI's dependencies (ink, react) are not installed for $ROOT. Start a Claude Code or Codex session so its SessionStart hook installs them, or rerun setup.sh." >&2
exit 1
