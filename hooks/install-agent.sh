#!/bin/bash
# install-agent.sh — SessionStart hook
#
# Installs the copilot-companion subagent to ~/.claude/agents/copilot-companion.md
# with ${CLAUDE_PLUGIN_ROOT} substituted to its absolute value at install time.
#
# Why we need this: the canonical way to scope an MCP server to a specific
# subagent only (so the parent session never sees it) is the agent's inline
# `mcpServers` frontmatter — but Claude Code silently ignores `mcpServers` /
# `hooks` / `permissionMode` for plugin-shipped agents. The official workaround
# in the docs is to copy the agent into `~/.claude/agents/` (user scope) where
# those fields are honored. This hook automates that copy on every session
# start, idempotently.
#
# After this runs, the standalone agent at ~/.claude/agents/copilot-companion.md
# spawns the bridge MCP server inline ONLY when the subagent is invoked. Main
# Claude has no `mcp__copilot-bridge__copilot_*` in its tool surface — there is
# no plugin-level .mcp.json registration anywhere.
#
# Idempotent: rewrites the destination only when its checksum changes.
# Sentinel-guarded: leaves alone any user-authored agent file at the same
# path (no auto-generated header → don't touch).
#
# Sentinel placement: must be INSIDE the YAML frontmatter as a `# ...` comment,
# not above the leading `---`. Claude Code's agent discovery requires the file
# to START with `---`; anything before that (HTML comment, blank line) makes
# the parser drop the file from /agents listing. We insert the sentinel as
# line 2, right after the opening `---`.

ROOT="${CLAUDE_PLUGIN_ROOT:-}"
[ -n "$ROOT" ] || exit 0

TEMPLATE="$ROOT/templates/copilot-companion.md"
[ -f "$TEMPLATE" ] || exit 0

DEST_DIR="$HOME/.claude/agents"
DEST="$DEST_DIR/copilot-companion.md"
SENTINEL="# AUTO-INSTALLED by copilot-companion plugin (hooks/install-agent.sh) — edits will be overwritten on next session"

mkdir -p "$DEST_DIR"

# Don't clobber a hand-edited or differently-sourced agent file. Only proceed
# if the destination either doesn't exist or contains our sentinel.
if [ -f "$DEST" ] && ! grep -qF "$SENTINEL" "$DEST"; then
  exit 0
fi

# Resolve an absolute path to a `node` binary so the MCP frontmatter's
# `command:` field doesn't depend on whatever PATH Claude Code inherits.
# This matters for nvm / mise / asdf users: their `node` is a shell function
# or shim only loadable via shell init. Claude Code spawns the MCP server
# via `child_process.spawn(command, args)` directly — NO shell, so
# .zshenv/.bashrc/etc are never sourced for that spawn. The spawn fails
# and the tool surfaces as "not available in this environment".
#
# Resolution order (each candidate is validated against a stripped env
# matching Claude Code's MCP-spawn env before being accepted):
#   1. `type -P node` — bash builtin that returns the binary path while
#      ignoring shell functions/aliases (robust against nvm's lazy loader).
#      May return a mise/asdf shim — we canonicalize via process.execPath
#      so the path baked into `command:` is the real binary, not the shim.
#   2. nvm's `default` alias, resolved recursively. nvm stores aliases as
#      plain files (not symlinks) and they can chain: `default` → `lts/*`
#      → `lts/jod` → `v22.x.x`. We follow the chain up to 10 hops; cycles
#      and dead ends fall through.
#   3. Highest installed nvm node version by `sort -V` — a deterministic
#      "latest local Node" fallback (semver-aware, so `v24` > `v4`).
#   4. Common system locations (Homebrew, /usr/local, /usr/bin).
# If none resolve, leave the template's literal `node` in place.
#
# Validation strategy: each candidate is executed under
# `env -i HOME PATH=/usr/bin:/bin <candidate> -e 'console.log(process.execPath)'`.
# This both (a) confirms the binary actually runs in a stripped env equivalent
# to what Claude Code will provide at spawn time and (b) returns the canonical
# binary path even when the candidate is a shim (mise/asdf) or a symlink chain
# (Homebrew Cellar). A candidate that fails to run is discarded so the next
# resolution step gets a chance.
_validate_node() {
  local candidate="$1"
  [ -n "$candidate" ] && [ -x "$candidate" ] || return 1
  env -i HOME="$HOME" PATH=/usr/bin:/bin \
    "$candidate" -e 'const major=Number(process.versions.node.split(".")[0]); if (major < 22) process.exit(1); console.log(process.execPath)' 2>/dev/null
}

NODE_BIN=""
if [ -z "$NODE_BIN" ]; then
  NODE_BIN="$(_validate_node "$(type -P node 2>/dev/null)")"
fi
if [ -z "$NODE_BIN" ] && [ -r "$HOME/.nvm/alias/default" ]; then
  ref="$(cat "$HOME/.nvm/alias/default" 2>/dev/null)"
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    case "$ref" in
      v[0-9]*)
        NODE_BIN="$(_validate_node "$HOME/.nvm/versions/node/$ref/bin/node")"
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
  unset ref next
fi
if [ -z "$NODE_BIN" ] && [ -d "$HOME/.nvm/versions/node" ]; then
  highest="$(ls -d "$HOME/.nvm/versions/node"/v* 2>/dev/null | sort -V | tail -n 1)"
  if [ -n "$highest" ]; then
    NODE_BIN="$(_validate_node "$highest/bin/node")"
  fi
  unset highest
fi
if [ -z "$NODE_BIN" ]; then
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
    NODE_BIN="$(_validate_node "$candidate")"
    [ -n "$NODE_BIN" ] && break
  done
fi

# Materialize: insert sentinel as a YAML-comment line right after the opening
# `---` of the frontmatter, substitute ${CLAUDE_PLUGIN_ROOT}, and (if we
# resolved one) rewrite `command: node` → absolute path so the MCP server
# spawn doesn't depend on PATH. awk insertion preserves the file starting
# with `---` so Claude Code's frontmatter parser sees a valid YAML block.
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
SED_ROOT="$(printf '%s' "$ROOT" | sed 's/[\/&|]/\\&/g')"

awk -v sentinel="$SENTINEL" 'NR==1 { print; print sentinel; next } { print }' "$TEMPLATE" \
  | sed "s|\${CLAUDE_PLUGIN_ROOT}|$SED_ROOT|g" \
  > "$TMP"

if [ -n "$NODE_BIN" ]; then
  # Anchor to the YAML pattern (whitespace + `command:` + space + `node` +
  # end-of-line) to avoid touching `command:` fields outside the MCP block,
  # and to be a no-op if the template ever switches to an absolute path.
  NODE_TMP="$(mktemp)"
  SED_NODE_BIN="$(printf '%s' "$NODE_BIN" | sed 's/[\/&|]/\\&/g')"
  sed "s|^\([[:space:]]*command:\) node[[:space:]]*$|\1 ${SED_NODE_BIN}|" "$TMP" > "$NODE_TMP" \
    && mv "$NODE_TMP" "$TMP"
fi

# Atomic update only if content actually changed (avoids spurious file mtime
# bumps and Claude Code's hot-reload churn on identical writes).
if ! cmp -s "$DEST" "$TMP" 2>/dev/null; then
  mv "$TMP" "$DEST"
  trap - EXIT
fi

exit 0
