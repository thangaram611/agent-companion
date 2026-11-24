# Shell hooks need these paths before Node or its dependencies are available.
# Keep in sync with lib/hosts/ (test/hosts.test.mjs exercises both).
# Match path.resolve for a custom CODEX_HOME, including a directory that setup
# has yet to create. A relative path is anchored before the installer changes cwd.
codex_config_dir() {
  local path="${CODEX_HOME:-}" part
  path="${path#"${path%%[![:space:]]*}"}"
  path="${path%"${path##*[![:space:]]}"}"
  if [ -z "$path" ]; then HOST_CONFIG_DIR="$HOME/.codex"; return; fi
  if [[ "$path" != /* ]]; then
    # Resolve the physical cwd with builtins, including on the empty-news path.
    local PWD="$PWD" OLDPWD="${OLDPWD:-}"
    cd -P . || return
    path="$PWD/$path"
  fi
  path="$path/"
  HOST_CONFIG_DIR=""
  while [ -n "$path" ]; do
    part="${path%%/*}"
    path="${path#*/}"
    case "$part" in
      ""|.) ;;
      ..) HOST_CONFIG_DIR="${HOST_CONFIG_DIR%/*}" ;;
      *) HOST_CONFIG_DIR="$HOST_CONFIG_DIR/$part" ;;
    esac
  done
  HOST_CONFIG_DIR="${HOST_CONFIG_DIR:-/}"
}

host_paths() {
  local host="$1" root="$2"
  case "$host" in
    copilot)
      HOST_CONFIG_DIR="${COPILOT_HOME:-$HOME/.copilot}"
      HOST_PLUGIN_DATA="${HOST_CONFIG_DIR%/}/agent-companion/deps"
      HOST_DEPS_LINK=""
      HOST_BRIDGE_IMPORT="$root/hooks/launch-agent-bridge.mjs"
      ;;
    opencode)
      HOST_CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
      HOST_PLUGIN_DATA="$root"
      HOST_DEPS_LINK=""
      HOST_BRIDGE_IMPORT=""
      ;;
    "codex")
      codex_config_dir
      HOST_PLUGIN_DATA="${PLUGIN_DATA:-${HOST_CONFIG_DIR%/}/plugins/data/agent-companion-agent-companion}"
      HOST_DEPS_LINK=""
      HOST_BRIDGE_IMPORT="$root/hooks/launch-agent-bridge.mjs"
      ;;
    *)
      HOST_CONFIG_DIR="$HOME/.claude"
      HOST_PLUGIN_DATA="${CLAUDE_PLUGIN_DATA:-${PLUGIN_DATA:-$root/.plugin-data}}"
      HOST_DEPS_LINK="$root/bridge-server/node_modules"
      HOST_BRIDGE_IMPORT=""
      ;;
  esac
  HOST_STATE_DIR="${HOST_CONFIG_DIR%/}/agent-companion"
}
