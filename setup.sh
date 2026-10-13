#!/usr/bin/env bash
# agent-companion — post-install setup
# Idempotent: safe to run multiple times.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

ok()   { printf "${GREEN}[OK]${NC}   %s\n" "$1"; }
warn() { printf "${YELLOW}[WARN]${NC} %s\n" "$1"; }
fail() { printf "${RED}[FAIL]${NC} %s\n" "$1"; }

# --- Argument parsing -------------------------------------------------------
#
# An omitted host is detected; an omitted target preserves existing configuration.
HOST=""
TARGET=""
NO_TARGET_CHECK=0
SKIP_TESTS=0
YES=0
DRY_RUN=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --host)   [ "$#" -ge 2 ] && [ -n "$2" ] || { fail "--host requires a value"; exit 2; }; HOST="$2"; shift 2 ;;
    --host=*) HOST="${1#--host=}"; [ -n "$HOST" ] || { fail "--host requires a value"; exit 2; }; shift ;;
    --target) [ "$#" -ge 2 ] && [ -n "$2" ] || { fail "--target requires a value"; exit 2; }; TARGET="$2"; shift 2 ;;
    --target=*) TARGET="${1#--target=}"; [ -n "$TARGET" ] || { fail "--target requires a value"; exit 2; }; shift ;;
    --no-target-check) NO_TARGET_CHECK=1; shift ;;
    --skip-tests)      SKIP_TESTS=1; shift ;;
    --yes|-y) YES=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help)
      cat <<EOF
Usage: $(basename "$0") [--host claude|codex|both] [--target opencode|copilot|codex|antigravity|auto|none]
                        [--no-target-check] [--skip-tests] [--yes] [--dry-run]

  --host claude|codex|both   install that harness surface (default: detect installed CLIs)
  --target opencode|copilot|codex|antigravity|auto|none
                             choose a default companion (default: preserve existing config,
                             otherwise select the only ready target). none preserves
                             config; auto explicitly selects the only ready target.
  --no-target-check          select the target without failing on not-ready
  --skip-tests               skip the unit-test step
  --yes                      apply without interactive confirmation
  --dry-run                  preview changes without installing or writing config
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
  ""|claude|codex|both) ;;
  *) fail "--host must be one of: claude, codex, both (got: $HOST)"; exit 2 ;;
esac

case "$TARGET" in
  ""|opencode|copilot|codex|antigravity|auto|none) ;;
  *) fail "--target must be one of: opencode, copilot, codex, antigravity, auto, none (got: $TARGET)"; exit 2 ;;
esac

# Host selection never assumes that both CLIs are installed.
if [ -z "$HOST" ]; then
  DETECTED=()
  command -v claude >/dev/null 2>&1 && DETECTED+=(claude)
  command -v codex >/dev/null 2>&1 && DETECTED+=(codex)
  case "${#DETECTED[@]}" in
    0) fail "No supported harness found. Install Claude Code or Codex CLI, then rerun with --host claude|codex."; exit 1 ;;
    1) HOST="${DETECTED[0]}"; ok "detected harness: $HOST" ;;
    *)
      if [ -t 0 ] && [ "$YES" = 0 ]; then
        read -r -p "Installed harnesses: claude, codex. Install for [claude/codex/both]: " HOST
        case "$HOST" in claude|codex|both) ;; *) fail "Select claude, codex or both."; exit 2 ;; esac
      else
        fail "Both harnesses are installed. Select --host claude|codex|both."; exit 2
      fi
      ;;
  esac
fi
DO_CLAUDE=0
DO_CODEX=0
HOSTS=()
case "$HOST" in
  claude) DO_CLAUDE=1; HOSTS=(claude) ;;
  codex) DO_CODEX=1; HOSTS=(codex) ;;
  both) DO_CLAUDE=1; DO_CODEX=1; HOSTS=(claude codex) ;;
esac

DEPS_STATUS="not installed this run"
CLAUDE_STATUS="not installed this run"
CODEX_STATUS="not installed this run"
CLAUDE_COMPANION="not inspected"
CODEX_COMPANION="not inspected"
TEST_STATUS="not run"
STEP="preflight"
APPLY_STARTED=0
PLAN_DIR=""
finish() {
  local code=$?
  [ -z "$PLAN_DIR" ] || rm -rf "$PLAN_DIR"
  echo ""
  if [ "$code" != 0 ]; then
    echo "=== Setup incomplete: $STEP ==="
    if [ "$APPLY_STARTED" = 0 ]; then
      echo "No installation changes applied."
    else
      echo "Completed steps remain installed; fix the error above and rerun the same command."
    fi
  elif [ "$DRY_RUN" = 1 ] || [ "$APPLY_STARTED" = 0 ]; then
    echo "=== Preview only; no installation changes applied ==="
  else
    echo "=== Setup complete (host=$HOST) ==="
  fi
  echo "Dependencies: $DEPS_STATUS; tests: $TEST_STATUS"
  if [ "$DO_CLAUDE" = 1 ]; then
    echo "Claude: $CLAUDE_STATUS; companion: $CLAUDE_COMPANION"
    [ "$APPLY_STARTED" = 0 ] || echo "  Start a fresh Claude session: claude --plugin-dir \"$SCRIPT_DIR\""
  fi
  if [ "$DO_CODEX" = 1 ]; then
    echo "Codex: $CODEX_STATUS; companion: $CODEX_COMPANION"
    if [ "$APPLY_STARTED" = 1 ]; then
      echo "  Run codex to start a fresh session. Approve the agent-companion plugin hooks if asked."
    fi
  fi
  echo "Unverified: live delegation and provider/model access (no quota-spending smoke run)."
}
trap finish EXIT

echo "=== agent-companion setup: preflight (host=$HOST) ==="

# --- Verify prerequisites -------------------------------------------

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

# Companion readiness is planned below, before any installation changes.

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
    if codex plugin marketplace add --help >/dev/null 2>&1 \
        && codex plugin add --help >/dev/null 2>&1; then
      ok "codex plugin marketplace/add commands available"
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

# --- Verify plugin surface is present -------------------------------
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
    "$SCRIPT_DIR/hooks/launch-agent-bridge.sh"
    "$SCRIPT_DIR/hooks/install-agent-codex.sh"
    "$SCRIPT_DIR/scripts/build-codex-marketplace.mjs"
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

# --- Companion preflight and change preview ---------------------------------

PLAN_DIR="$(mktemp -d)"
SELECTED_TARGETS=()
for h in "${HOSTS[@]}"; do
  ONBOARD_ARGS=(--host "$h" --plan --json --set-default --yes)
  [ -z "$TARGET" ] || ONBOARD_ARGS+=(--target "$TARGET")
  [ "$NO_TARGET_CHECK" = 0 ] || ONBOARD_ARGS+=(--no-target-check)
  PLAN_CODE=0
  AGENT_COMPANION_HOST="$h" node "$SCRIPT_DIR/scripts/onboard.mjs" "${ONBOARD_ARGS[@]}" > "$PLAN_DIR/$h.json" || PLAN_CODE=$?
  if ! jq -e '.configuration and .plan' "$PLAN_DIR/$h.json" >/dev/null; then
    fail "Cannot inspect $h configuration; no changes applied."; exit 1
  fi
  CURRENT="$(jq -r '.configuration.summary' "$PLAN_DIR/$h.json")"
  case "$h" in claude) CLAUDE_COMPANION="$CURRENT" ;; codex) CODEX_COMPANION="$CURRENT" ;; esac
  echo "Companion ($h): $CURRENT"
  jq -r '.configuration.profiles[] | "  Profile: \(.id) → \(.companion); ready=\(.ready)", (.blockers[], .warnings[] | "    " + .message)' "$PLAN_DIR/$h.json"
  jq -r '.configuration.errors[] | "  Attention: " + .' "$PLAN_DIR/$h.json"
  jq -r '.targets[] | "  \(.displayName): " + (if .ready then "ready" else "not ready" end), (.blockers[], .warnings[] | "    " + .message), (.nextSteps[] | "    Next: " + .)' "$PLAN_DIR/$h.json"
  if [ "$PLAN_CODE" != 0 ] && [ -t 0 ] && [ "$YES" = 0 ] \
      && jq -e '.plan.code == "ambiguous_target" or .plan.code == "no_ready_target"' "$PLAN_DIR/$h.json" >/dev/null; then
    read -r -p "Companion for $h [opencode/copilot/codex/antigravity/none]: " CHOICE
    PLAN_CODE=0
    AGENT_COMPANION_HOST="$h" node "$SCRIPT_DIR/scripts/onboard.mjs" "${ONBOARD_ARGS[@]}" --target "$CHOICE" > "$PLAN_DIR/$h.json" || PLAN_CODE=$?
  fi
  if [ "$PLAN_CODE" != 0 ]; then
    jq -r '.plan.message // "Selected companion is not ready. Fix its prerequisites, or explicitly use --no-target-check."' "$PLAN_DIR/$h.json"
    exit "$PLAN_CODE"
  fi
  CHOICE="$(jq -r 'if .plan.kind == "chosen" then .plan.id else "none" end' "$PLAN_DIR/$h.json")"
  SELECTED_TARGETS+=("$CHOICE")
  if [ "$CHOICE" = none ]; then
    echo "Plan ($h): preserve companion configuration."
  else
    echo "Plan ($h): set default companion to $CHOICE; preserve profiles and model settings."
    jq -r 'if .plan.ready then empty else "  Readiness deferred by --no-target-check; companion is not ready." end' "$PLAN_DIR/$h.json"
  fi
  if [ "$h" = codex ]; then
    AGENT_FILE="${CODEX_HOME:-$HOME/.codex}/agents/agent-companion.toml"
  else
    AGENT_FILE="$HOME/.claude/agents/agent-companion.md"
  fi
  if [ -f "$AGENT_FILE" ] && ! grep -qF '# AUTO-INSTALLED by agent-companion plugin' "$AGENT_FILE"; then
    fail "User-owned agent preserved: $AGENT_FILE. Move or reconcile it manually before rerunning."; exit 1
  fi
  [ ! -e "$AGENT_FILE" ] || echo "Existing $h agent found; setup will refresh and verify it."
done

echo "Intended installation changes:"
echo "  Install bridge-server dependencies in $SCRIPT_DIR/bridge-server."
[ "$DO_CLAUDE" = 0 ] || echo "  Materialize the Claude agent; merge companion permissions into ~/.claude/settings.json."
[ "$DO_CODEX" = 0 ] || echo "  Create ${CODEX_HOME:-$HOME/.codex} if needed; refresh the Codex plugin, verify MCP and agent, and remove legacy managed hooks."
echo "  Write diagnostic install markers after each harness finishes."
if [ "$TARGET" = copilot ] || command -v copilot >/dev/null 2>&1; then
  echo "  Install the Copilot reviewer agent if absent (preserve any existing file)."
fi
if [ "$DRY_RUN" = 1 ]; then exit 0; fi
if [ -t 0 ] && [ "$YES" = 0 ]; then
  read -r -p "Apply these changes? [y/N] " ANSWER
  case "$ANSWER" in y|Y|yes|YES) ;; *) exit 0 ;; esac
fi
APPLY_STARTED=1
STEP="bridge dependencies"

# --- Install node_modules for bridge server -------------------------

printf "Installing bridge server dependencies...\n"
BRIDGE_DIR="$SCRIPT_DIR/bridge-server"
if [ -d "$BRIDGE_DIR" ] && [ -f "$BRIDGE_DIR/package.json" ]; then
  if [ -f "$BRIDGE_DIR/package-lock.json" ]; then
    cd "$BRIDGE_DIR" && npm ci --silent --no-audit --no-fund
  else
    cd "$BRIDGE_DIR" && npm install --silent --no-audit --no-fund
  fi
  DEPS_STATUS="installed"
  ok "bridge-server node_modules installed"
else
  fail "bridge-server/package.json not found at $BRIDGE_DIR"
  exit 1
fi

echo ""

# --- Copilot-side reviewer agent (Copilot target only) --------------
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

# --- Claude-host install (subagent + permissions) -------------------

if [ "$DO_CLAUDE" = 1 ]; then
  STEP="Claude agent and permissions"
  printf "=== Claude Code host install ===\n"

  # 5a. Eagerly materialize the Markdown subagent. Idempotent.
  printf "Materializing subagent at ~/.claude/agents/agent-companion.md...\n"
  CLAUDE_PLUGIN_ROOT="$SCRIPT_DIR" bash "$SCRIPT_DIR/hooks/install-agent.sh"
  if [ -f "$HOME/.claude/agents/agent-companion.md" ]; then
    CLAUDE_STATUS="agent installed; permissions pending"
    ok "subagent installed at ~/.claude/agents/agent-companion.md"
  else
    fail "subagent install hook ran but file not found — check $SCRIPT_DIR/hooks/install-agent.sh"
    exit 1
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
  CLAUDE_STATUS="agent and permissions installed"
  ok "diagnostic marker: ~/.claude/agent-companion/.host"

  echo ""
fi

# --- Codex-host install (local marketplace plugin + subagent TOML) ---
#
# Current Codex deliberately ignores mcp_servers added by an agent role: a
# child may inherit its parent's MCP authority but may not expand it. Installing
# the Codex-only plugin manifest is therefore required even for source-checkout
# development. Re-adding the same local plugin atomically refreshes its cached
# package, so this path remains idempotent during iteration.

if [ "$DO_CODEX" = 1 ]; then
  STEP="Codex plugin installation"
  printf "=== Codex CLI host install ===\n"
  CODEX_DATA_ROOT="${CODEX_HOME:-$HOME/.codex}"
  # Codex requires an explicit CODEX_HOME to exist before plugin commands.
  mkdir -p "$CODEX_DATA_ROOT"

  # 6a. Build and install/refresh the local Codex plugin. The manifest owns the
  # MCP registration and plugin-scoped hooks; no root .mcp.json is installed,
  # so this does not alter Claude's MCP discovery.
  CODEX_MARKETPLACE_DIR="$SCRIPT_DIR/dist/codex-marketplace"
  printf "Building and registering the local Codex marketplace...\n"
  if node "$SCRIPT_DIR/scripts/build-codex-marketplace.mjs" \
      --out "$CODEX_MARKETPLACE_DIR"; then
    ok "Codex marketplace package built"
  else
    fail "Codex marketplace build failed"
    exit 1
  fi

  if codex plugin marketplace add "$CODEX_MARKETPLACE_DIR" --json >/dev/null; then
    CODEX_STATUS="marketplace registered; plugin pending"
    ok "Codex marketplace registered"
  else
    fail "Codex marketplace registration failed — remove or rename any different marketplace already named agent-companion"
    exit 1
  fi

  PLUGIN_RESULT=""
  if PLUGIN_RESULT="$(codex plugin add agent-companion@agent-companion --json)"; then
    CODEX_STATUS="plugin installed; MCP, agent and hooks pending verification"
    ok "Codex plugin installed/refreshed"
  else
    fail "Codex plugin install failed"
    exit 1
  fi
  INSTALLED_PLUGIN_ROOT="$(printf '%s\n' "$PLUGIN_RESULT" | jq -er \
    '.installedPath | select(type == "string" and length > 0)' 2>/dev/null || true)"
  if [ -z "$INSTALLED_PLUGIN_ROOT" ] || [ ! -d "$INSTALLED_PLUGIN_ROOT" ]; then
    fail "Codex plugin add returned no usable installedPath"
    exit 1
  fi

  # Plugin installation alone does not prove Codex accepted the MCP manifest.
  # Ask a fresh CLI process for its effective registry and validate the exact
  # bridge transport before changing the user's legacy hook state.
  MCP_RESULT=""
  if MCP_RESULT="$(codex mcp list --json)"; then
    MCP_BRIDGE_CWD="$(printf '%s\n' "$MCP_RESULT" | jq -er '
      .[] | select(.name == "agent-bridge"
        and .enabled == true
        and .transport.type == "stdio"
        and .transport.command == "/bin/bash"
        and (.transport.args | length) == 1
        and .transport.args[0] == "hooks/launch-agent-bridge.sh"
        and .transport.env.AGENT_COMPANION_HOST == "codex"
        and .transport.env.CODEX_RUNTIME_ADAPTER == "appserver"
        and (.transport.env_vars | type) == "array"
        and (.transport.env_vars | length) == 0
        and .startup_timeout_sec == 120
        and .tool_timeout_sec == 1320)
      | .transport.cwd' 2>/dev/null || true)"
  else
    MCP_BRIDGE_CWD=""
  fi
  if [ -z "$MCP_BRIDGE_CWD" ] || [ ! -d "$MCP_BRIDGE_CWD" ] \
      || ! [ "$MCP_BRIDGE_CWD" -ef "$INSTALLED_PLUGIN_ROOT" ]; then
    fail "Codex installed the plugin but did not register its agent-bridge MCP transport"
    exit 1
  fi
  STEP="Codex agent and hooks"
  ok "Codex agent-bridge MCP registration verified"

  # 6b. Eagerly materialize the TOML subagent from the installed package.
  # SessionStart repeats this after upgrades, but doing it now makes the next
  # fresh Codex session usable even before any hook has run.
  printf "Materializing subagent at %s/agents/agent-companion.toml...\n" "$CODEX_DATA_ROOT"
  CLAUDE_PLUGIN_ROOT="$INSTALLED_PLUGIN_ROOT" \
    /bin/bash "$INSTALLED_PLUGIN_ROOT/hooks/install-agent-codex.sh"
  AGENT_DEST="$CODEX_DATA_ROOT/agents/agent-companion.toml"
  AGENT_SENTINEL="# AUTO-INSTALLED by agent-companion plugin (hooks/install-agent-codex.sh) — edits will be overwritten on next session"
  AGENT_EXPECTED="$(mktemp)"
  {
    printf '%s\n' "$AGENT_SENTINEL"
    /bin/cat "$INSTALLED_PLUGIN_ROOT/templates/agent-companion.toml"
  } > "$AGENT_EXPECTED"
  if [ -f "$AGENT_DEST" ] && cmp -s "$AGENT_DEST" "$AGENT_EXPECTED"; then
    ok "subagent installed at $AGENT_DEST"
    rm -f "$AGENT_EXPECTED"
  else
    rm -f "$AGENT_EXPECTED"
    fail "cannot verify $AGENT_DEST; a user-owned file at that path is preserved and must be moved or reconciled manually"
    exit 1
  fi

  # 6c. Remove only this project's pre-plugin managed global hook entries.
  # Current installs use hooks/hooks-codex.json from plugin scope; leaving the
  # old copies in $CODEX_HOME/hooks.json would deliver every event twice.
  printf "Removing legacy managed Codex hook entries, if present...\n"
  if node "$SCRIPT_DIR/scripts/install-codex-hooks.mjs" \
      --plugin-root "$SCRIPT_DIR" --uninstall --yes; then
    ok "legacy managed hook entries absent"
  else
    fail "legacy managed hook cleanup failed — see error above"
    exit 1
  fi

  # 6d. Permission injection — explicit no-op so future Codex permission
  # work has an obvious place to plug in. Keeps the flow uniform across
  # hosts.
  printf "Permission injection (Codex)...\n"
  if node "$SCRIPT_DIR/scripts/install-permissions.mjs" --host codex --yes; then
    ok "permission step ran"
  else
    fail "permission step exited non-zero — see error above"
    exit 1
  fi

  # 6e. Diagnostic marker.
  mkdir -p "$CODEX_DATA_ROOT/agent-companion"
  printf "codex\n" > "$CODEX_DATA_ROOT/agent-companion/.host"
  CODEX_STATUS="plugin, MCP, agent and hooks installed/verified"
  ok "diagnostic marker: $CODEX_DATA_ROOT/agent-companion/.host"

  echo ""
fi

# --- Syntax-check all .mjs files ------------------------------------

STEP="syntax checks"
printf "Syntax-checking scripts...\n"
FAIL_COUNT=0
while IFS= read -r -d '' f; do
  [ -f "$f" ] || continue
  if node --check "$f" 2>/dev/null; then
    ok "${f#$SCRIPT_DIR/}"
  else
    fail "${f#$SCRIPT_DIR/} — syntax error"
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
done < <(
  find "$SCRIPT_DIR" -not -path "$SCRIPT_DIR/bridge-server/node_modules/*" -name '*.mjs' -print0
)

if [ "$FAIL_COUNT" -gt 0 ]; then
  fail "$FAIL_COUNT file(s) have syntax errors"
  exit 1
fi

echo ""

# --- Run unit tests -------------------------------------------------

if [ "$SKIP_TESTS" = 1 ]; then
  TEST_STATUS="skipped (--skip-tests)"
  warn "skipping unit tests (--skip-tests)"
  echo ""
else
STEP="unit tests"
TEST_STATUS="failed or interrupted"
printf "Running unit tests...\n"
# Single source of truth: every `*.test.mjs` under the project tree. Avoids
# the README / inline-list drift problem (new tests were getting added but
# this list was not updated).
EXISTING=()
while IFS= read -r -d '' f; do EXISTING+=("$f"); done < <(
  find "$SCRIPT_DIR" -not -path "$SCRIPT_DIR/bridge-server/node_modules/*" -name '*.test.mjs' -print0
)

if [ "${#EXISTING[@]}" -gt 0 ]; then
  if node --test "${EXISTING[@]}" 2>/dev/null; then
    TEST_STATUS="passed"
    ok "unit tests passed"
  else
    fail "unit tests failed"
    exit 1
  fi
else
  fail "No test files found under $SCRIPT_DIR"
  exit 1
fi

echo ""
fi

# Commit only the explicitly planned defaults after installation/checks succeed.
STEP="companion configuration"
for i in "${!HOSTS[@]}"; do
  h="${HOSTS[$i]}"
  CHOICE="${SELECTED_TARGETS[$i]}"
  [ "$CHOICE" != none ] || continue
  ONBOARD_ARGS=(--host "$h" --target "$CHOICE" --set-default --yes --json)
  [ "$NO_TARGET_CHECK" = 0 ] || ONBOARD_ARGS+=(--no-target-check)
  if AGENT_COMPANION_HOST="$h" node "$SCRIPT_DIR/scripts/onboard.mjs" "${ONBOARD_ARGS[@]}" > "$PLAN_DIR/$h-result.json"; then
    CURRENT="$(jq -r '.configuration.summary' "$PLAN_DIR/$h-result.json")"
    jq -r 'if .ok then empty else "Companion readiness deferred; fix prerequisites before delegating." end' "$PLAN_DIR/$h-result.json"
    case "$h" in claude) CLAUDE_COMPANION="$CURRENT" ;; codex) CODEX_COMPANION="$CURRENT" ;; esac
  else
    jq -r '(.report.blockers[]?.message), (.report.nextSteps[]? | "Next: " + .)' "$PLAN_DIR/$h-result.json" 2>/dev/null || true
    fail "Companion configuration failed for $h; previous configuration preserved. Fix prerequisites and rerun."
    exit 1
  fi
done
