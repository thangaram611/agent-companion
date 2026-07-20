#!/usr/bin/env bash
# agent-companion v0.0.1 — post-install setup
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
# --host claude|codex|both    which harness surface(s) to install (default both)
# --target opencode|copilot|auto|none
#                             which companion target to onboard. Delegated to
#                             scripts/onboard.mjs. Default: none (host/plugin
#                             surface only — attach a companion later).
# --no-target-check           write/select the target but don't fail if it
#                             isn't ready yet.
# --skip-tests                skip the unit-test step (lighter install path).

HOST="both"
TARGET="none"
NO_TARGET_CHECK=0
SKIP_TESTS=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --host)   HOST="${2:-}"; shift 2 ;;
    --host=*) HOST="${1#--host=}"; shift ;;
    --target)   TARGET="${2:-}"; shift 2 ;;
    --target=*) TARGET="${1#--target=}"; shift ;;
    --no-target-check) NO_TARGET_CHECK=1; shift ;;
    --skip-tests)      SKIP_TESTS=1; shift ;;
    -h|--help)
      cat <<EOF
Usage: $(basename "$0") [--host claude|codex|both] [--target opencode|copilot|auto|none]
                        [--no-target-check] [--skip-tests]

  --host claude|codex|both   install that harness surface (default both)
  --target opencode|copilot|auto|none
                             onboard a companion target (default none; attach
                             one later). auto picks the only ready target.
  --no-target-check          select the target without failing on not-ready
  --skip-tests               skip the unit-test step
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

case "$TARGET" in
  opencode|copilot|auto|none) ;;
  *) fail "--target must be one of: opencode, copilot, auto, none (got: $TARGET)"; exit 2 ;;
esac

DO_CLAUDE=0
DO_CODEX=0
case "$HOST" in
  claude) DO_CLAUDE=1 ;;
  codex)  DO_CODEX=1 ;;
  both)   DO_CLAUDE=1; DO_CODEX=1 ;;
esac

echo "=== agent-companion setup (host=$HOST) ==="
echo ""
echo "This directory is a dual-harness plugin (Claude Code + Codex CLI). The"
echo "subagent-scoped MCP architecture stays the same on both sides — only"
echo "the agent file format and per-host install location differ."
echo ""
echo "Terminology: setup uses --host for today's harness selector and --target"
echo "for today's companion selector. Future strength routing will allow multiple"
echo "companion profiles behind strength names such as reviewer or web_researcher."
echo ""
if [ "$DO_CLAUDE" = 1 ]; then
  echo "    .claude-plugin/plugin.json       Claude plugin manifest"
  echo "    templates/agent-companion.md   subagent template (Markdown + YAML frontmatter)"
  echo "    hooks/hooks.json                 SessionStart hooks: install-agent + prewarm + deps + drain"
fi
if [ "$DO_CODEX" = 1 ]; then
  echo "    .codex-plugin/plugin.json        Codex plugin manifest"
  echo "    templates/agent-companion.toml subagent template (TOML)"
  echo "    hooks/hooks-codex.json           plugin-scoped hooks for marketplace packages"
  echo "    scripts/install-codex-hooks.mjs  source-checkout dev hook materialization"
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

# Companion binaries (copilot / opencode) are NOT common prerequisites — this
# bridge lets users attach their preferred companion. Readiness is validated
# later, only for the target selected via --target, by scripts/onboard.mjs.

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
  "$SCRIPT_DIR/hooks/prewarm-target.sh"
)
if [ "$DO_CLAUDE" = 1 ]; then
  SURFACE_PATHS+=(
    "$SCRIPT_DIR/.claude-plugin/plugin.json"
    "$SCRIPT_DIR/templates/agent-companion.md"
    "$SCRIPT_DIR/hooks/hooks.json"
    "$SCRIPT_DIR/hooks/install-agent.sh"
  )
fi
if [ "$DO_CODEX" = 1 ]; then
  SURFACE_PATHS+=(
    "$SCRIPT_DIR/.codex-plugin/plugin.json"
    "$SCRIPT_DIR/templates/agent-companion.toml"
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

# --- Step 4: Copilot-side reviewer agent (Copilot target only) --------------
#
# This is Copilot-specific. Only set it up when Copilot is the selected target
# or is already installed (so existing Copilot users keep it); an OpenCode-only
# install skips it entirely.

if [ "$TARGET" = "copilot" ] || command -v copilot >/dev/null 2>&1; then
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
fi

# --- Step 5: Claude-host install (subagent + permissions) -------------------

if [ "$DO_CLAUDE" = 1 ]; then
  printf "=== Claude Code host install ===\n"

  # 5a. Eagerly materialize the Markdown subagent. Idempotent.
  printf "Materializing subagent at ~/.claude/agents/agent-companion.md...\n"
  CLAUDE_PLUGIN_ROOT="$SCRIPT_DIR" bash "$SCRIPT_DIR/hooks/install-agent.sh"
  if [ -f "$HOME/.claude/agents/agent-companion.md" ]; then
    ok "subagent installed at ~/.claude/agents/agent-companion.md"
  else
    warn "subagent install hook ran but file not found — check $SCRIPT_DIR/hooks/install-agent.sh"
  fi

  # 5b. Permission allow-list — without an explicit allow rule, the first
  # invocation of a agent-bridge MCP tool can surface a permission
  # prompt. Plugin-shipped settings.json cannot declare permissions, so
  # we merge into the user's ~/.claude/settings.json.
  printf "Granting Claude companion permissions in ~/.claude/settings.json...\n"
  if node "$SCRIPT_DIR/scripts/install-permissions.mjs" --host claude --yes; then
    ok "permission entries present"
  else
    fail "permission step failed — see error above; re-run \`node scripts/install-permissions.mjs --host claude --yes\` after fixing"
    exit 1
  fi

  # 5c. Diagnostic marker.
  mkdir -p "$HOME/.claude/agent-companion"
  printf "claude\n" > "$HOME/.claude/agent-companion/.host"
  ok "diagnostic marker: ~/.claude/agent-companion/.host"

  echo ""
fi

# --- Step 6: Codex-host install (subagent TOML + dev hook materialization) ---
#
# Codex has first-class plugin marketplace commands now. Published packages use
# hooks/hooks-codex.json in plugin scope. For this source checkout, setup
# materializes the custom TOML agent and dev hooks directly so local iteration
# does not require a package/install round trip.

if [ "$DO_CODEX" = 1 ]; then
  printf "=== Codex CLI host install ===\n"

  # 6a. Eagerly materialize the TOML subagent. Idempotent.
  printf "Materializing subagent at ~/.codex/agents/agent-companion.toml...\n"
  CLAUDE_PLUGIN_ROOT="$SCRIPT_DIR" bash "$SCRIPT_DIR/hooks/install-agent-codex.sh"
  if [ -f "$HOME/.codex/agents/agent-companion.toml" ]; then
    ok "subagent installed at ~/.codex/agents/agent-companion.toml"
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
  mkdir -p "$HOME/.codex/agent-companion"
  printf "codex\n" > "$HOME/.codex/agent-companion/.host"
  ok "diagnostic marker: ~/.codex/agent-companion/.host"

  echo ""
fi

# --- Step 7: Companion onboarding (attach your companion) -------------------
#
# Delegated entirely to scripts/onboard.mjs. Writes the per-host default-target
# and prints target install/auth next steps. Skipped for --target none.

if [ "$TARGET" = "none" ]; then
  ok "no companion selected (--target none); first send must pass an explicit target, or run \`node scripts/onboard.mjs --target <id> --set-default\` later"
else
  for h in claude codex; do
    case "$h" in
      claude) [ "$DO_CLAUDE" = 1 ] || continue ;;
      codex)  [ "$DO_CODEX" = 1 ] || continue ;;
    esac
    printf "Onboarding companion target '%s' for harness '%s'...\n" "$TARGET" "$h"
    ONBOARD_ARGS=(--host "$h" --target "$TARGET" --set-default --yes)
    [ "$NO_TARGET_CHECK" = 1 ] && ONBOARD_ARGS+=(--no-target-check)
    if AGENT_COMPANION_HOST="$h" node "$SCRIPT_DIR/scripts/onboard.mjs" "${ONBOARD_ARGS[@]}"; then
      ok "companion target '$TARGET' onboarded for $h"
    else
      fail "target '$TARGET' is not ready (or onboarding failed) — see next steps above. Fix it and re-run, or pass --no-target-check to proceed anyway."
      exit 1
    fi
  done
fi

echo ""

# --- Step 8: Syntax-check all .mjs files ------------------------------------

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

# --- Step 9: Run unit tests -------------------------------------------------

if [ "$SKIP_TESTS" = 1 ]; then
  warn "skipping unit tests (--skip-tests)"
  echo ""
else
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
fi

# --- Done -------------------------------------------------------------------

echo "=== Setup complete (host=$HOST, target=$TARGET) ==="
echo ""
if [ "$DO_CLAUDE" = 1 ]; then
  echo "Claude Code:"
  echo "  claude --plugin-dir \"$SCRIPT_DIR\""
  echo "  (or after publishing: /plugin install agent-companion)"
  echo ""
fi
if [ "$DO_CODEX" = 1 ]; then
  echo "Codex CLI:"
  echo "  codex   # subagent + hooks are now wired into ~/.codex/"
  echo "  Then ask main Codex to delegate (e.g. \"have the agent companion audit the auth module\")."
  echo ""
fi
echo "Describe what you want in natural language and the host will spawn the"
echo "agent-companion subagent automatically. The bridge is spawned inline"
echo "per invocation."
