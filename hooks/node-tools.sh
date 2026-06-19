#!/bin/bash
# Shared Node/npm resolver for hook scripts.
#
# Hooks can run under GUI-launched hosts with a stripped PATH, so relying on a
# bare `node` or `npm` command is fragile for nvm/mise/asdf users. These helpers
# return binaries that can execute under a minimal environment.

_cc_validate_node() {
  local candidate="$1"
  [ -n "$candidate" ] && [ -x "$candidate" ] || return 1
  env -i HOME="$HOME" PATH=/usr/bin:/bin \
    "$candidate" -e 'const major=Number(process.versions.node.split(".")[0]); if (major < 22) process.exit(1); console.log(process.execPath)' 2>/dev/null
}

resolve_node() {
  local node_bin="" ref="" next="" highest="" candidate=""

  if [ -n "${AGENT_COMPANION_NODE:-}" ]; then
    node_bin="$(_cc_validate_node "$AGENT_COMPANION_NODE")"
    [ -n "$node_bin" ] && printf '%s\n' "$node_bin" && return 0
  fi

  node_bin="$(_cc_validate_node "$(type -P node 2>/dev/null)")"
  [ -n "$node_bin" ] && printf '%s\n' "$node_bin" && return 0

  if [ -r "$HOME/.nvm/alias/default" ]; then
    ref="$(cat "$HOME/.nvm/alias/default" 2>/dev/null)"
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      case "$ref" in
        v[0-9]*)
          node_bin="$(_cc_validate_node "$HOME/.nvm/versions/node/$ref/bin/node")"
          [ -n "$node_bin" ] && printf '%s\n' "$node_bin" && return 0
          break
          ;;
      esac
      if [ -r "$HOME/.nvm/alias/$ref" ]; then
        next="$(cat "$HOME/.nvm/alias/$ref" 2>/dev/null)"
        [ -n "$next" ] && [ "$next" != "$ref" ] || break
        ref="$next"
      else
        break
      fi
    done
  fi

  if [ -d "$HOME/.nvm/versions/node" ]; then
    highest="$(ls -d "$HOME/.nvm/versions/node"/v* 2>/dev/null | sort -V | tail -n 1)"
    if [ -n "$highest" ]; then
      node_bin="$(_cc_validate_node "$highest/bin/node")"
      [ -n "$node_bin" ] && printf '%s\n' "$node_bin" && return 0
    fi
  fi

  for candidate in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
    node_bin="$(_cc_validate_node "$candidate")"
    [ -n "$node_bin" ] && printf '%s\n' "$node_bin" && return 0
  done

  return 1
}

resolve_npm() {
  local node_bin="" node_dir="" candidate=""

  if [ -n "${AGENT_COMPANION_NPM:-}" ] && [ -x "$AGENT_COMPANION_NPM" ]; then
    printf '%s\n' "$AGENT_COMPANION_NPM"
    return 0
  fi

  node_bin="$(resolve_node 2>/dev/null || true)"
  if [ -n "$node_bin" ]; then
    node_dir="$(dirname "$node_bin")"
    for candidate in "$node_dir/npm" "$node_dir/npm-cli.js"; do
      [ -x "$candidate" ] && printf '%s\n' "$candidate" && return 0
    done
  fi

  candidate="$(type -P npm 2>/dev/null)"
  [ -n "$candidate" ] && [ -x "$candidate" ] && printf '%s\n' "$candidate" && return 0

  for candidate in /opt/homebrew/bin/npm /usr/local/bin/npm /usr/bin/npm; do
    [ -x "$candidate" ] && printf '%s\n' "$candidate" && return 0
  done

  return 1
}
