#!/usr/bin/env bash
# copilot-companion v0.0.1 — post-install setup
# Idempotent: safe to run multiple times.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

ok()   { printf "${GREEN}[OK]${NC}   %s\n" "$1"; }
warn() { printf "${YELLOW}[WARN]${NC} %s\n" "$1"; }
fail() { printf "${RED}[FAIL]${NC} %s\n" "$1"; }

# --- Argument parsing -------------------------------------------------------
#
# --host claude            — install the Claude Code surface only
# --host codex             — install the Codex CLI surface only
# --host both   (default) — install both modern host surfaces

HOST="both"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --host)
      HOST="${2:-}"; shift 2
      ;;
    --host=*)
      HOST="${1#--host=}"; shift
      ;;
    -h|--help)
      cat <<EOF
Usage: $(basename "$0") [--host claude|codex|both]

  --host claude             install Claude Code surface only
  --host codex    install Codex CLI surface only
  --host both     (default) install both
EOF
      exit 0
      ;;
    *)
      fail "unknown argument: $1"
      exit 2
      ;;
  esac
done

case "$HOST" in
  claude|codex|both) ;;
  *) fail "--host must be one of: claude, codex, both (got: $HOST)"; exit 2 ;;
esac

DO_CLAUDE=0
DO_CODEX=0
case "$HOST" in
  claude) DO_CLAUDE=1 ;;
  codex)  DO_CODEX=1 ;;
  both)   DO_CLAUDE=1; DO_CODEX=1 ;;
esac

echo "=== copilot-companion setup (host=$HOST) ==="
echo ""
echo "This directory is a dual-host plugin (Claude Code + Codex CLI). The"
echo "subagent-scoped MCP architecture stays the same on both sides — only"
echo "the agent file format and per-host install location differ."
echo ""
if [ "$DO_CLAUDE" = 1 ]; then
  echo "    .claude-plugin/plugin.json       Claude plugin manifest"
  echo "    templates/copilot-companion.md   subagent template (Markdown + YAML frontmatter)"
  echo "    hooks/hooks.json                 SessionStart hooks: install-agent + prewarm + deps + drain"
fi
if [ "$DO_CODEX" = 1 ]; then
  echo "    .codex-plugin/plugin.json        Codex plugin manifest"
  echo "    templates/copilot-companion.toml subagent template (TOML)"
  echo "    hooks/hooks.json                 hook source; setup also materializes dev hooks"
fi
echo ""

# --- Step 1: Verify prerequisites -------------------------------------------

printf "Checking prerequisites...\n"

if ! command -v node >/dev/null 2>&1; then
  fail "node not found on PATH. Install Node.js >= 22."
  exit 1
fi
NODE_VER=$(node -e "console.log(process.version.slice(1).split('.')[0])")
if [ "$NODE_VER" -lt 22 ] 2>/dev/null; then
  fail "Node.js >= 22 required (found v$NODE_VER)."
  exit 1
fi
ok "node v$(node --version | tr -d 'v')"

if ! command -v npm >/dev/null 2>&1; then
  fail "npm not found on PATH."
  exit 1
fi
ok "npm $(npm --version)"

if ! command -v jq >/dev/null 2>&1; then
  fail "jq not found on PATH. Install jq; hook delivery depends on it."
  exit 1
fi
ok "jq $(jq --version 2>/dev/null || echo found)"

if command -v copilot >/dev/null 2>&1; then
  ok "copilot $(copilot --version 2>/dev/null || echo 'found')"
else
  fail "copilot binary not found on PATH. Install GitHub Copilot CLI first."
  exit 1
fi

if [ "$DO_CLAUDE" = 1 ]; then
  if command -v claude >/dev/null 2>&1; then
    ok "claude found"
  else
    fail "claude (Claude Code CLI) not found. Install from https://claude.ai/code"
    exit 1
  fi
fi

if [ "$DO_CODEX" = 1 ]; then
  if command -v codex >/dev/null 2>&1; then
    ok "codex $(codex --version 2>/dev/null | head -1 || echo 'found')"
    if codex plugin add --help >/dev/null 2>&1; then
      ok "codex plugin add available"
    else
      fail "codex plugin add is unavailable; install a current Codex CLI."
      exit 1
    fi
  else
    fail "codex (Codex CLI) not found. Install from https://github.com/openai/codex"
    exit 1
  fi
fi

echo ""

# --- Step 2: Install node_modules for bridge server -------------------------

printf "Installing bridge server dependencies...\n"
BRIDGE_DIR="$SCRIPT_DIR/bridge-server"
if [ -d "$BRIDGE_DIR" ] && [ -f "$BRIDGE_DIR/package.json" ]; then
  if [ -f "$BRIDGE_DIR/package-lock.json" ]; then
    cd "$BRIDGE_DIR" && npm ci --silent --no-audit --no-fund
  else
    cd "$BRIDGE_DIR" && npm install --silent --no-audit --no-fund
  fi
  ok "bridge-server node_modules installed"
else
  fail "bridge-server/package.json not found at $BRIDGE_DIR"
  exit 1
fi

echo ""

# --- Step 3: Verify plugin surface is present -------------------------------
#
# Per-host the surface differs. We always check the host-agnostic shared
# files, then add per-host files when that host is in scope.

printf "Checking plugin surface...\n"

SURFACE_PATHS=(
  "$SCRIPT_DIR/hooks/drain-completions.sh"
  "$SCRIPT_DIR/hooks/install-deps.sh"
  "$SCRIPT_DIR/hooks/prewarm-daemon.sh"
)
if [ "$DO_CLAUDE" = 1 ]; then
  SURFACE_PATHS+=(
    "$SCRIPT_DIR/.claude-plugin/plugin.json"
    "$SCRIPT_DIR/templates/copilot-companion.md"
    "$SCRIPT_DIR/hooks/hooks.json"
    "$SCRIPT_DIR/hooks/install-agent.sh"
  )
fi
if [ "$DO_CODEX" = 1 ]; then
  SURFACE_PATHS+=(
    "$SCRIPT_DIR/.codex-plugin/plugin.json"
    "$SCRIPT_DIR/templates/copilot-companion.toml"
    "$SCRIPT_DIR/hooks/install-agent-codex.sh"
    "$SCRIPT_DIR/scripts/install-codex-hooks.mjs"
  )
fi

for path in "${SURFACE_PATHS[@]}"; do
  if [ -f "$path" ]; then
    ok "$(basename "$path")"
  else
    fail "missing: $path"
    exit 1
  fi
done

echo ""

# --- Step 4: Copilot-side reviewer agent (host-agnostic) --------------------

printf "Setting up Copilot reviewer agent...\n"
COPILOT_AGENTS="$HOME/.copilot/agents"
REVIEWER_AGENT="$COPILOT_AGENTS/reviewer.agent.md"
mkdir -p "$COPILOT_AGENTS"
if [ ! -f "$REVIEWER_AGENT" ]; then
  if [ -f "$SCRIPT_DIR/.copilot/agents/reviewer.agent.md" ]; then
    cp "$SCRIPT_DIR/.copilot/agents/reviewer.agent.md" "$REVIEWER_AGENT"
    ok "reviewer.agent.md copied to $COPILOT_AGENTS/"
  else
    warn "reviewer.agent.md source not found, skipping"
  fi
else
  ok "reviewer.agent.md already exists"
fi

echo ""

# --- Step 5: Claude-host install (subagent + permissions + agent-teams) -----

if [ "$DO_CLAUDE" = 1 ]; then
  printf "=== Claude Code host install ===\n"

  # 5a. Eagerly materialize the Markdown subagent. Idempotent.
  printf "Materializing subagent at ~/.claude/agents/copilot-companion.md...\n"
  CLAUDE_PLUGIN_ROOT="$SCRIPT_DIR" bash "$SCRIPT_DIR/hooks/install-agent.sh"
  if [ -f "$HOME/.claude/agents/copilot-companion.md" ]; then
    ok "subagent installed at ~/.claude/agents/copilot-companion.md"
  else
    warn "subagent install hook ran but file not found — check $SCRIPT_DIR/hooks/install-agent.sh"
  fi

  # 5b. Permission allow-list — without an explicit allow rule, the first
  # invocation of a copilot-bridge MCP tool can surface a permission
  # prompt. Plugin-shipped settings.json cannot declare permissions, so
  # we merge into the user's ~/.claude/settings.json.
  printf "Granting MCP permission in ~/.claude/settings.json...\n"
  if node "$SCRIPT_DIR/scripts/install-permissions.mjs" --host claude --yes; then
    ok "permission entry present"
  else
    fail "permission step failed — see error above; re-run \`node scripts/install-permissions.mjs --host claude --yes\` after fixing"
    exit 1
  fi

  # 5c. Agent Teams env var.
  printf "Checking Agent Teams configuration...\n"
  ZSHRC="$HOME/.zshrc"
  if [ -f "$ZSHRC" ] && grep -q 'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS' "$ZSHRC"; then
    ok "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS already in $ZSHRC"
  else
    echo '' >> "$ZSHRC"
    echo '# Claude Code: enable experimental agent teams for multi-agent orchestration' >> "$ZSHRC"
    echo 'export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1' >> "$ZSHRC"
    ok "Added CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 to $ZSHRC"
    warn "Run 'source ~/.zshrc' or restart your terminal for this to take effect."
  fi

  # 5d. Diagnostic marker.
  mkdir -p "$HOME/.claude/copilot-companion"
  printf "claude\n" > "$HOME/.claude/copilot-companion/.host"
  ok "diagnostic marker: ~/.claude/copilot-companion/.host"

  echo ""
fi

# --- Step 6: Codex-host install (subagent TOML + dev hook materialization) ---
#
# Codex has first-class plugin marketplace commands now. For this source
# checkout, setup materializes the custom TOML agent and dev hooks directly;
# the published path is marketplace registration plus `codex plugin add`.

if [ "$DO_CODEX" = 1 ]; then
  printf "=== Codex CLI host install ===\n"

  # 6a. Eagerly materialize the TOML subagent. Idempotent.
  printf "Materializing subagent at ~/.codex/agents/copilot-companion.toml...\n"
  CLAUDE_PLUGIN_ROOT="$SCRIPT_DIR" bash "$SCRIPT_DIR/hooks/install-agent-codex.sh"
  if [ -f "$HOME/.codex/agents/copilot-companion.toml" ]; then
    ok "subagent installed at ~/.codex/agents/copilot-companion.toml"
  else
    warn "subagent install hook ran but file not found — check $SCRIPT_DIR/hooks/install-agent-codex.sh"
  fi

  # 6b. Hook entries — read-merge-backup-write into ~/.codex/hooks.json.
  printf "Merging hook entries into ~/.codex/hooks.json...\n"
  if node "$SCRIPT_DIR/scripts/install-codex-hooks.mjs" --plugin-root "$SCRIPT_DIR" --yes; then
    ok "hook entries present"
  else
    fail "hook merge failed — see error above; re-run \`node scripts/install-codex-hooks.mjs --plugin-root \"$SCRIPT_DIR\" --yes\` after fixing"
    exit 1
  fi

  # 6c. Permission injection — explicit no-op so future Codex permission
  # work has an obvious place to plug in. Keeps the flow uniform across
  # hosts.
  printf "Permission injection (Codex)...\n"
  if node "$SCRIPT_DIR/scripts/install-permissions.mjs" --host codex --yes; then
    ok "permission step ran"
  else
    fail "permission step exited non-zero — see error above"
    exit 1
  fi

  # 6d. Diagnostic marker.
  mkdir -p "$HOME/.codex/copilot-companion"
  printf "codex\n" > "$HOME/.codex/copilot-companion/.host"
  ok "diagnostic marker: ~/.codex/copilot-companion/.host"

  echo ""
fi

# --- Step 7: Syntax-check all .mjs files ------------------------------------

printf "Syntax-checking scripts...\n"
FAIL_COUNT=0
while IFS= read -r f; do
  [ -f "$f" ] || continue
  if node --check "$f" 2>/dev/null; then
    ok "${f#$SCRIPT_DIR/}"
  else
    fail "${f#$SCRIPT_DIR/} — syntax error"
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
done < <(
  find "$SCRIPT_DIR/bridge-server" "$SCRIPT_DIR/lib" "$SCRIPT_DIR/scripts" \
       "$SCRIPT_DIR/hooks" "$SCRIPT_DIR/templates" \
       -path '*/node_modules' -prune -o \
       -type f -name '*.mjs' -print 2>/dev/null
)

if [ "$FAIL_COUNT" -gt 0 ]; then
  fail "$FAIL_COUNT file(s) have syntax errors"
  exit 1
fi

echo ""

# --- Step 8: Run unit tests -------------------------------------------------

printf "Running unit tests...\n"
# Single source of truth: every `*.test.mjs` under the project tree. Avoids
# the README / inline-list drift problem (new tests were getting added but
# this list was not updated).
EXISTING=()
while IFS= read -r f; do EXISTING+=("$f"); done < <(
  find "$SCRIPT_DIR/bridge-server" "$SCRIPT_DIR/lib" "$SCRIPT_DIR/scripts" \
       "$SCRIPT_DIR/hooks" "$SCRIPT_DIR/templates" \
       -path '*/node_modules' -prune -o \
       -type f -name '*.test.mjs' -print 2>/dev/null
)

if [ "${#EXISTING[@]}" -gt 0 ]; then
  if node --test "${EXISTING[@]}" 2>/dev/null; then
    ok "unit tests passed"
  else
    fail "unit tests failed"
    exit 1
  fi
else
  warn "test files not found, skipping"
fi

echo ""

# --- Done -------------------------------------------------------------------

echo "=== Setup complete (host=$HOST) ==="
echo ""
if [ "$DO_CLAUDE" = 1 ]; then
  echo "Claude Code:"
  echo "  claude --plugin-dir \"$SCRIPT_DIR\""
  echo "  (or after publishing: /plugin install copilot-companion)"
  echo ""
fi
if [ "$DO_CODEX" = 1 ]; then
  echo "Codex CLI:"
  echo "  codex   # subagent + hooks are now wired into ~/.codex/"
  echo "  Then ask main Codex to delegate (e.g. \"have copilot audit the auth module\")."
  echo ""
fi
echo "Describe what you want in natural language and the host will spawn the"
echo "copilot-companion subagent automatically. The bridge is spawned inline"
echo "per invocation."
