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

. "$SCRIPT_DIR/hooks/host-paths.sh"
. "$SCRIPT_DIR/hooks/node-tools.sh"

read_registry_ids() {
  if ! command -v node >/dev/null 2>&1; then
    node_requirement_error ''
    exit 1
  fi
  NODE_VERSION=$(node --version)
  NODE_VER="${NODE_VERSION#v}"
  if [ "${NODE_VER%%.*}" -lt 26 ] 2>/dev/null; then
    node_requirement_error "$NODE_VERSION"
    exit 1
  fi
  COMPANION_IDS=$(node -p '[...require(process.argv[1]).COMPANION_IDS].join(" ")' "$SCRIPT_DIR/lib/companion-registry.mjs")
  HOST_IDS=$(node -p 'Object.keys(require(process.argv[1]).HOSTS).join(" ")' "$SCRIPT_DIR/lib/hosts/index.mjs")
}

# --- Argument parsing -------------------------------------------------------
#
# An omitted host is detected; an omitted companion preserves existing configuration.
HOST=""
COMPANION=""
MODEL=""
NO_COMPANION_CHECK=0
SKIP_TESTS=0
YES=0
DRY_RUN=0
UNLOAD_DELAY=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --host)   [ "$#" -ge 2 ] && [ -n "$2" ] || { fail "--host requires a value"; exit 2; }; HOST="$2"; shift 2 ;;
    --host=*) HOST="${1#--host=}"; [ -n "$HOST" ] || { fail "--host requires a value"; exit 2; }; shift ;;
    --companion) [ "$#" -ge 2 ] && [ -n "$2" ] || { fail "--companion requires a value"; exit 2; }; COMPANION="$2"; shift 2 ;;
    --companion=*) COMPANION="${1#--companion=}"; [ -n "$COMPANION" ] || { fail "--companion requires a value"; exit 2; }; shift ;;
    --model) [ "$#" -ge 2 ] && [ -n "$2" ] && [[ "$2" != -* ]] || { fail "--model requires a value"; exit 2; }; MODEL="$2"; shift 2 ;;
    --model=*) MODEL="${1#--model=}"; [ -n "$MODEL" ] || { fail "--model requires a value"; exit 2; }; shift ;;
    --codex-unload-delay) [[ "${2:-}" =~ ^([0-9]+|default)$ ]] || { fail "--codex-unload-delay takes seconds or default"; exit 2; }; UNLOAD_DELAY="$2"; shift 2 ;;
    --codex-unload-delay=*) UNLOAD_DELAY="${1#--codex-unload-delay=}"; [[ "$UNLOAD_DELAY" =~ ^([0-9]+|default)$ ]] || { fail "--codex-unload-delay takes seconds or default"; exit 2; }; shift ;;
    --no-companion-check) NO_COMPANION_CHECK=1; shift ;;
    --skip-tests)      SKIP_TESTS=1; shift ;;
    --yes|-y) YES=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help)
      read_registry_ids
      cat <<EOF
Usage: $(basename "$0") [--host ${HOST_IDS// /|}|both] [--companion ${COMPANION_IDS// /|}|auto|none]
                        [--model <id|inherit>] [--codex-unload-delay <seconds|default>]
                        [--no-companion-check] [--skip-tests] [--yes] [--dry-run]

  --host ${HOST_IDS// /|}|both   install that host surface (default: detect installed CLIs)
  --companion ${COMPANION_IDS// /|}|auto|none
                             choose a default companion (default: preserve existing config,
                             otherwise select the only ready companion). none preserves
                             config; auto explicitly selects the only ready companion.
  --model <id|inherit>       save a model for an explicit companion; inherit clears it
  --codex-unload-delay <seconds|default>
                             how long Codex keeps a conversation you left loaded
                             (thread_unload_delay_secs, Codex default 60). Lower ends
                             its wakes and its running jobs sooner; default removes it.
  --no-companion-check       select the companion without failing on not-ready
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

read_registry_ids
has_id() {
  local wanted="$1" id
  shift
  for id in "$@"; do [ "$wanted" != "$id" ] || return 0; done
  return 1
}

if ! has_id "$HOST" "" $HOST_IDS both; then
  fail "--host must be one of: ${HOST_IDS// /, }, both (got: $HOST)"; exit 2
fi
if ! has_id "$COMPANION" "" $COMPANION_IDS auto none; then
  fail "--companion must be one of: ${COMPANION_IDS// /, }, auto, none (got: $COMPANION)"; exit 2
fi

if [ -n "$MODEL" ]; then
  case "$COMPANION" in
    ""|auto|none) fail "--model requires an explicit --companion <companion> (not auto or none)."; exit 2 ;;
  esac
fi

# Host selection never assumes that both CLIs are installed.
if [ -z "$HOST" ]; then
  DETECTED=()
  for h in $HOST_IDS; do command -v "$h" >/dev/null 2>&1 && DETECTED+=("$h"); done
  case "${#DETECTED[@]}" in
    0) fail "No supported host found. Install Claude Code or Codex CLI, then rerun with --host ${HOST_IDS// /|}."; exit 1 ;;
    1) HOST="${DETECTED[0]}"; ok "detected host: $HOST" ;;
    *)
      if [ -t 0 ] && [ "$YES" = 0 ]; then
        read -r -p "Installed hosts: ${HOST_IDS// /, }. Install for [${HOST_IDS// /\/}/both]: " HOST
        has_id "$HOST" $HOST_IDS both || { fail "Select ${HOST_IDS// /, } or both."; exit 2; }
      else
        fail "Both hosts are installed. Select --host ${HOST_IDS// /|}|both."; exit 2
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
  both) DO_CLAUDE=1; DO_CODEX=1; HOSTS=($HOST_IDS) ;;
esac
if [ -n "$UNLOAD_DELAY" ] && [ "$DO_CODEX" = 0 ]; then
  fail "--codex-unload-delay needs a Codex host (--host codex or both)"; exit 2
fi

DEPS_STATUS="not installed this run"
UI_STATUS="not installed this run"
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
  echo "Live view: $UI_STATUS"
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
  "$SCRIPT_DIR/hooks/hook.sh"
  "$SCRIPT_DIR/hooks/hook.mjs"
  "$SCRIPT_DIR/hooks/install-deps.sh"
)
if [ "$DO_CLAUDE" = 1 ]; then
  SURFACE_PATHS+=(
    "$SCRIPT_DIR/.claude-plugin/plugin.json"
    "$SCRIPT_DIR/hooks/hooks.json"
  )
fi
if [ "$DO_CODEX" = 1 ]; then
  SURFACE_PATHS+=(
    "$SCRIPT_DIR/.codex-plugin/plugin.json"
    "$SCRIPT_DIR/hooks/launch-agent-bridge.sh"
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
SELECTED_COMPANIONS=()
SELECTED_MODELS=()
for h in "${HOSTS[@]}"; do
  MODEL_CHOICE="$MODEL"
  ONBOARD_ARGS=(--host "$h" --plan --json --set-default --yes)
  [ -z "$COMPANION" ] || ONBOARD_ARGS+=(--companion "$COMPANION")
  [ -z "$MODEL_CHOICE" ] || ONBOARD_ARGS+=(--model "$MODEL_CHOICE")
  [ "$NO_COMPANION_CHECK" = 0 ] || ONBOARD_ARGS+=(--no-companion-check)
  PLAN_CODE=0
  AGENT_COMPANION_HOST="$h" node "$SCRIPT_DIR/scripts/onboard.mjs" "${ONBOARD_ARGS[@]}" > "$PLAN_DIR/$h.json" || PLAN_CODE=$?
  if ! jq -e '.configuration and .plan' "$PLAN_DIR/$h.json" >/dev/null; then
    fail "Cannot inspect $h configuration; no changes applied."; exit 1
  fi
  CURRENT="$(jq -r '.configuration.summary' "$PLAN_DIR/$h.json")"
  case "$h" in claude) CLAUDE_COMPANION="$CURRENT" ;; codex) CODEX_COMPANION="$CURRENT" ;; esac
  echo "Companion ($h): $CURRENT"
  jq -r '.companions[] | "  \(.displayName): " + (if .ready then "ready" else "not ready" end), (.blockers[], .warnings[] | "    " + .message), (.nextSteps[] | "    Next: " + .)' "$PLAN_DIR/$h.json"
  if [ "$PLAN_CODE" != 0 ] && [ -t 0 ] && [ "$YES" = 0 ] \
      && jq -e '.plan.code == "ambiguous_companion" or .plan.code == "no_ready_companion"' "$PLAN_DIR/$h.json" >/dev/null; then
    read -r -p "Shared default companion [${COMPANION_IDS// /\/}/none]: " CHOICE
    if jq -e --arg id "$CHOICE" '.companions[$id].capabilities.modelSelection == true' "$PLAN_DIR/$h.json" >/dev/null; then
      read -r -p "Default model for $CHOICE [inherit]: " MODEL_CHOICE
      [ "$MODEL_CHOICE" != inherit ] || MODEL_CHOICE=""
      [ -z "$MODEL_CHOICE" ] || ONBOARD_ARGS+=(--model "$MODEL_CHOICE")
    fi
    COMPANION="$CHOICE"
    MODEL="$MODEL_CHOICE"
    PLAN_CODE=0
    AGENT_COMPANION_HOST="$h" node "$SCRIPT_DIR/scripts/onboard.mjs" "${ONBOARD_ARGS[@]}" --companion "$CHOICE" > "$PLAN_DIR/$h.json" || PLAN_CODE=$?
  fi
  if [ "$PLAN_CODE" != 0 ]; then
    jq -r '.plan.message // "Selected companion is not ready. Fix its prerequisites, or explicitly use --no-companion-check."' "$PLAN_DIR/$h.json"
    exit "$PLAN_CODE"
  fi
  CHOICE="$(jq -r 'if .plan.kind == "chosen" then .plan.id else "none" end' "$PLAN_DIR/$h.json")"
  SELECTED_COMPANIONS+=("$CHOICE")
  SELECTED_MODELS+=("$MODEL_CHOICE")
  if [ "$CHOICE" = none ]; then
    echo "Plan ($h): preserve companion configuration."
  else
    if [ -n "$MODEL_CHOICE" ]; then
      echo "Plan ($h): set default companion to $CHOICE; model $MODEL_CHOICE."
    else
      echo "Plan ($h): set default companion to $CHOICE; preserve model settings."
    fi
    jq -r 'if .plan.ready then empty else "  Readiness deferred by --no-companion-check; companion is not ready." end' "$PLAN_DIR/$h.json"
  fi
  host_paths "$h" "$SCRIPT_DIR"
  if [ -f "$HOST_AGENT_FILE" ]; then
    if grep -q '^# AUTO-INSTALLED by agent-companion plugin' "$HOST_AGENT_FILE"; then
      echo "  Remove the retired plugin role at $HOST_AGENT_FILE."
    else
      echo "  User-owned agent preserved: $HOST_AGENT_FILE"
    fi
  fi
done

echo "Intended installation changes:"
echo "  Install bridge-server dependencies in $SCRIPT_DIR/bridge-server."
echo "  Install or refresh the live-view launcher ~/.local/bin/agent-companion (runs this checkout's hooks/launch-ui.sh)."
[ "$DO_CLAUDE" = 0 ] || echo "  Merge companion permissions into ~/.claude/settings.json."
if [ "$DO_CODEX" = 1 ]; then
  host_paths codex "$SCRIPT_DIR"
  echo "  Create $HOST_CONFIG_DIR if needed; refresh the Codex plugin, verify MCP, and remove legacy managed hooks."
  case "$UNLOAD_DELAY" in
    '') ;;
    default) echo "  Remove thread_unload_delay_secs from $HOST_CONFIG_DIR/config.toml (applies when Codex's daemon restarts)." ;;
    *) echo "  Set thread_unload_delay_secs to $UNLOAD_DELAY in $HOST_CONFIG_DIR/config.toml (applies when Codex's daemon restarts)." ;;
  esac
fi
echo "  Write diagnostic install markers after each host finishes."
if [ "$MODEL" = inherit ]; then
  echo "  Clear the shared default model for ${SELECTED_COMPANIONS[0]}."
elif [ -n "$MODEL" ]; then
  echo "  Save shared default model $MODEL for ${SELECTED_COMPANIONS[0]}."
fi
if [ "$COMPANION" = copilot ] || command -v copilot >/dev/null 2>&1; then
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
  # Claude's SessionStart links node_modules into its plugin data. npm ci would
  # empty that install through the link, so drop only the link; the next
  # session start links it again.
  [ ! -L "$BRIDGE_DIR/node_modules" ] || rm "$BRIDGE_DIR/node_modules"
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

# --- Live-view launcher (host-independent) ---------------------------------

STEP="live-view launcher"
printf "Installing the live-view launcher...\n"
UI_OUTPUT="$(node "$SCRIPT_DIR/scripts/install-ui-launcher.mjs")"
printf '%s\n' "$UI_OUTPUT"
case "$UI_OUTPUT" in
  *"left unchanged"*) UI_STATUS="launcher not installed; a file agent-companion did not write is kept" ;;
  *"not on PATH"*) UI_STATUS="run ~/.local/bin/agent-companion ui (add ~/.local/bin to PATH for agent-companion ui)" ;;
  *) UI_STATUS="run agent-companion ui" ;;
esac

echo ""

# --- Copilot-side reviewer agent (Copilot companion only) --------------
#
# This is Copilot-specific. Only set it up when Copilot is the selected companion
# or is already installed (so existing Copilot users keep it); an OpenCode-only
# install skips it entirely.

if [ "$COMPANION" = "copilot" ] || command -v copilot >/dev/null 2>&1; then
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

remove_retired_role() {
  if [ -f "$HOST_AGENT_FILE" ] && grep -q '^# AUTO-INSTALLED by agent-companion plugin' "$HOST_AGENT_FILE"; then
    rm -- "$HOST_AGENT_FILE"
  fi
}

if [ "$DO_CLAUDE" = 1 ]; then
  STEP="Claude permissions"
  printf "=== Claude Code host install ===\n"
  host_paths claude "$SCRIPT_DIR"
  remove_retired_role

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
  mkdir -p "$HOST_STATE_DIR"
  printf "claude\n" > "$HOST_STATE_DIR/.host"
  CLAUDE_STATUS="permissions installed"
  ok "diagnostic marker: ~/.claude/agent-companion/.host"

  echo ""
fi

# --- Codex marketplace installation ---
if [ "$DO_CODEX" = 1 ]; then
  STEP="Codex plugin installation"
  printf "=== Codex CLI host install ===\n"
  host_paths codex "$SCRIPT_DIR"
  # Codex requires an explicit CODEX_HOME to exist before plugin commands.
  mkdir -p "$HOST_CONFIG_DIR"

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
    CODEX_STATUS="plugin installed; MCP and hooks pending verification"
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
  STEP="Codex hooks"
  ok "Codex agent-bridge MCP registration verified"

  remove_retired_role

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

  # 6e. Opt-in: how long Codex keeps a conversation you left loaded, and so its bridge, its jobs and its wakes.
  if [ -n "$UNLOAD_DELAY" ]; then
    if node "$SCRIPT_DIR/scripts/install-codex-unload-delay.mjs" "$UNLOAD_DELAY"; then
      warn "Codex reads thread_unload_delay_secs when its app-server daemon starts: run 'codex app-server daemon restart' (it stops running Codex work) or restart Codex."
    else
      fail "writing Codex's thread_unload_delay_secs failed — see error above"; exit 1
    fi
  fi

  # 6f. Diagnostic marker.
  mkdir -p "$HOST_STATE_DIR"
  printf "codex\n" > "$HOST_STATE_DIR/.host"
  CODEX_STATUS="plugin, MCP and hooks installed/verified"
  ok "diagnostic marker: $HOST_STATE_DIR/.host"

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
  CHOICE="${SELECTED_COMPANIONS[$i]}"
  [ "$CHOICE" != none ] || continue
  ONBOARD_ARGS=(--host "$h" --companion "$CHOICE" --set-default --yes --json)
  [ -z "${SELECTED_MODELS[$i]}" ] || ONBOARD_ARGS+=(--model "${SELECTED_MODELS[$i]}")
  [ "$NO_COMPANION_CHECK" = 0 ] || ONBOARD_ARGS+=(--no-companion-check)
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
