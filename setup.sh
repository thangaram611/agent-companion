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
OPENCODE_IDLE=""
idle_writer="$SCRIPT_DIR/scripts/install-opencode-idle-timeout.mjs"
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
    --opencode-idle-timeout|--opencode-idle-timeout=*)
      if [[ "$1" == *=* ]]; then
        OPENCODE_IDLE="${1#*=}"
      else
        shift
        OPENCODE_IDLE="${1:-}"
      fi
      node "$idle_writer" --check "$OPENCODE_IDLE" || exit 2
      shift
      ;;
    --no-companion-check) NO_COMPANION_CHECK=1; shift ;;
    --skip-tests)      SKIP_TESTS=1; shift ;;
    --yes|-y) YES=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help)
      read_registry_ids
      cat <<EOF
Usage: $(basename "$0") [--host ${HOST_IDS// /|}|both|all] [--companion ${COMPANION_IDS// /|}|auto|none]
                        [--model <id|inherit>] [--codex-unload-delay <seconds|default>]
                        [--opencode-idle-timeout <duration|false|default>]
                        [--no-companion-check] [--skip-tests] [--yes] [--dry-run]

  --host ${HOST_IDS// /|}|both|all   install that host surface (default: detect installed CLIs)
  --companion ${COMPANION_IDS// /|}|auto|none
                             choose a default companion (default: preserve existing config,
                             otherwise select the only ready companion). none preserves
                             config; auto explicitly selects the only ready companion.
  --model <id|inherit>       save a model for an explicit companion; inherit clears it
  --codex-unload-delay <seconds|default>
                             how long Codex keeps a conversation you left loaded
                             (thread_unload_delay_secs, Codex default 60). Lower ends
                             its wakes and its running jobs sooner; default removes it.
  --opencode-idle-timeout <duration|false|default>
                             how long OpenCode keeps an idle directory loaded (e.g. "8 hours").
                             false keeps every directory's servers loaded until the service stops.
                             default removes the global override (OpenCode default: 60 minutes).
  --no-companion-check       select the companion without failing on not-ready
  --skip-tests               skip the unit-test step
  --yes                      apply without interactive confirmation
  --dry-run                  preview setup changes; native CLI probes may initialize profiles, caches and databases
EOF
      exit 0
      ;;
    *)
      fail "unknown argument: $1. Run bash setup.sh --help."
      exit 2
      ;;
  esac
done

codex_config_dir
export CODEX_HOME="$HOST_CONFIG_DIR"
read_registry_ids
has_id() {
  local wanted="$1" id
  shift
  for id in "$@"; do [ "$wanted" != "$id" ] || return 0; done
  return 1
}

if ! has_id "$HOST" "" $HOST_IDS both all; then
  fail "--host must be one of: ${HOST_IDS// /, }, both, all (got: $HOST)"; exit 2
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
slash=/
if [ -z "$HOST" ]; then
  DETECTED=()
  for h in $HOST_IDS; do command -v "$h" >/dev/null 2>&1 && DETECTED+=("$h"); done
  case "${#DETECTED[@]}" in
    0) fail "No supported host found. Install a supported CLI, then rerun with --host ${HOST_IDS// /|}."; exit 1 ;;
    1) HOST="${DETECTED[0]}"; ok "detected host: $HOST" ;;
    *)
      choices="${DETECTED[*]}"
      if has_id claude "${DETECTED[@]}" && has_id codex "${DETECTED[@]}"; then choices="$choices both"; fi
      if [ "${DETECTED[*]}" = "$HOST_IDS" ]; then choices="$choices all"; fi
      if [ -t 0 ] && [ "$YES" = 0 ]; then
        read -r -p "Installed hosts: ${DETECTED[*]}. Install for [${choices// /$slash}]: " HOST
        has_id "$HOST" $choices || { fail "Select one of: $choices."; exit 2; }
      else
        fail "Multiple hosts are installed: ${DETECTED[*]}. Select --host ${choices// /|}."; exit 2
      fi
      ;;
  esac
fi
case "$HOST" in
  both) HOSTS=(claude codex) ;;
  all) HOSTS=($HOST_IDS) ;;
  *) HOSTS=("$HOST") ;;
esac
DO_CLAUDE=0
DO_CODEX=0
DO_OPENCODE=0
DO_COPILOT=0
for h in "${HOSTS[@]}"; do
  case "$h" in claude) DO_CLAUDE=1 ;; codex) DO_CODEX=1 ;; opencode) DO_OPENCODE=1 ;; copilot) DO_COPILOT=1 ;; esac
done
if [ -n "$UNLOAD_DELAY" ] && [ "$DO_CODEX" = 0 ]; then
  fail "--codex-unload-delay needs a Codex host (--host codex, both or all)"; exit 2
fi

if [ -n "$OPENCODE_IDLE" ] && [ "$DO_OPENCODE" = 0 ]; then
  fail "--opencode-idle-timeout needs an OpenCode host (--host opencode or all)"; exit 2
fi

DEPS_STATUS="not installed this run"
UI_STATUS="not installed this run"
CLAUDE_STATUS="not installed this run"
CODEX_STATUS="not installed this run"
OPENCODE_STATUS="not installed this run"
COPILOT_STATUS="not installed this run"
CURRENT="not inspected"
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
    echo "Claude: $CLAUDE_STATUS; companion: $CURRENT"
    [ "$CLAUDE_STATUS" != "permissions installed" ] || echo "  Start a fresh Claude session: claude --plugin-dir \"$SCRIPT_DIR\""
  fi
  if [ "$DO_CODEX" = 1 ]; then
    echo "Codex: $CODEX_STATUS; companion: $CURRENT"
    if [ "$CODEX_STATUS" = "plugin, MCP and hooks installed/verified" ]; then
      echo "  Run codex to start a fresh session. Approve the agent-companion plugin hooks if asked."
    fi
  fi
  if [ "$DO_OPENCODE" = 1 ]; then
    echo "OpenCode: $OPENCODE_STATUS"
    if [ "$OPENCODE_STATUS" = installed ]; then
      echo "  If the service is stopped, the next OpenCode launch loads the plugin. If running, restart it after current jobs finish."
    fi
  fi
  if [ "$DO_COPILOT" = 1 ]; then
    echo "Copilot: $COPILOT_STATUS"
    [ "$COPILOT_STATUS" != installed ] || echo "  Start a fresh Copilot session and approve agent-bridge when prompted."
  fi
  echo "Unverified: live delegation and provider/model access (no quota-spending smoke run)."
}
trap finish EXIT

echo "=== agent-companion setup: preflight (host=$HOST) ==="

# --- Verify prerequisites -------------------------------------------

if [ "$DRY_RUN" = 1 ]; then
  echo "Preview uses temporary plan files. Native CLI probes may create or update profile settings, backups, caches and databases."
fi
printf "Checking prerequisites...\n"

ok "node v$(node --version | tr -d 'v')"

if ! command -v npm >/dev/null 2>&1; then
  fail "npm not found on PATH."
  exit 1
fi
ok "npm $(npm --version)"

if ! command -v jq >/dev/null 2>&1; then
  fail "jq not found on PATH. Install jq for source setup."
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

if [ "$DO_OPENCODE" = 1 ] && ! opencode plugin add --help >/dev/null 2>&1; then
  fail "OpenCode with plugin add support is required."; exit 1
fi

if [ "$DO_COPILOT" = 1 ] && ! copilot plugin marketplace list --help >/dev/null 2>&1; then
  fail "Copilot CLI with local marketplace support is required."; exit 1
fi

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
  )
fi

if [ "$DO_OPENCODE" = 1 ]; then
  SURFACE_PATHS+=("$SCRIPT_DIR/opencode-plugin/package.json" "$SCRIPT_DIR/opencode-plugin/server.js" "$SCRIPT_DIR/hooks/launch-agent-bridge.sh")
fi
if [ "$DO_COPILOT" = 1 ]; then
  SURFACE_PATHS+=("$SCRIPT_DIR/.github/plugin/plugin.json" "$SCRIPT_DIR/.claude-plugin/marketplace.json"
    "$SCRIPT_DIR/hooks/hooks-copilot.json" "$SCRIPT_DIR/hooks/copilot.mjs"
    "$SCRIPT_DIR/hooks/launch-agent-bridge.sh" "$SCRIPT_DIR/extensions/notice/extension.mjs")
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
# Check every selected registration before npm or the shared launcher changes.
CODEX_MARKETPLACE_DIR="$SCRIPT_DIR/dist/codex-marketplace"
market_source() {
  local filter="$1"
  shift
  local source
  if ! source=$("$@" | jq -er "$filter"); then
    fail "Cannot inspect registration with $*." >&2
    return 1
  fi
  printf '%s\n' "$source"
}
if [ "$DO_CLAUDE" = 1 ]; then
  market=$(market_source 'map(select(.name == "agent-companion") | .path // .url // .repo // .installLocation // error("missing source")) | join("\n")' claude plugin marketplace list --json)
  if [ -n "$market" ] && ! [ "$market" -ef "$SCRIPT_DIR" ]; then
    fail "Claude marketplace points to $market. Run this command, then rerun setup: CLAUDE_CONFIG_DIR=$(printf %q "${CLAUDE_CONFIG_DIR:-$HOME/.claude}") claude plugin marketplace remove agent-companion"
    exit 1
  fi
fi
if [ "$DO_CODEX" = 1 ] && [ -d "$CODEX_HOME" ]; then
  market=$(market_source '.marketplaces | map(select(.name == "agent-companion") | .marketplaceSource.source // error("missing source")) | join("\n")' codex plugin marketplace list --json)
  if [ -n "$market" ] && [ "$market" != "$CODEX_MARKETPLACE_DIR" ] && ! [ "$market" -ef "$CODEX_MARKETPLACE_DIR" ]; then
    fail "Codex marketplace points to $market. Run this command, then rerun setup: CODEX_HOME=$(printf %q "$CODEX_HOME") codex plugin marketplace remove agent-companion"
    exit 1
  fi
fi
if [ "$DO_OPENCODE" = 1 ]; then
  host_paths opencode "$SCRIPT_DIR"
  local_plugin="$HOST_CONFIG_DIR/plugins/agent-companion"
  if [ -e "$local_plugin" ] || [ -L "$local_plugin" ]; then
    if ! [ "$local_plugin" -ef "$SCRIPT_DIR/opencode-plugin" ]; then
      if [ -L "$local_plugin" ]; then
        fail "OpenCode plugin points to $(readlink "$local_plugin"). To move it, run: $(printf 'unlink %q' "$local_plugin")"
      else
        fail "OpenCode plugin path is occupied. Move it aside before retrying: $(printf 'mv -i %q %q' "$local_plugin" "$local_plugin.previous")"
      fi
      exit 1
    fi
  fi
fi
check_copilot_market() {
  market=$(market_source 'map(select(.name == "agent-companion") | .source // error("missing source")) | join("\n")' copilot plugin marketplace list --json)
  if [ -n "$market" ] && ! [ "${market#Local: }" -ef "$SCRIPT_DIR" ]; then
    fail "Copilot marketplace points to $market. To switch checkouts, remove that marketplace and its plugins, then rerun setup: COPILOT_HOME=$(printf %q "${COPILOT_HOME:-$HOME/.copilot}") copilot plugin marketplace remove agent-companion --force"
    exit 1
  fi
}
if [ "$DO_COPILOT" = 1 ]; then check_copilot_market; fi

plan_file="$PLAN_DIR/plan.json"
ONBOARD_ARGS=(--host "$HOST" --plan --json --set-default)
if [ ! -t 0 ] || [ "$YES" = 1 ]; then ONBOARD_ARGS+=(--yes); fi
[ -z "$COMPANION" ] || ONBOARD_ARGS+=(--companion "$COMPANION")
[ -z "$MODEL" ] || ONBOARD_ARGS+=(--model "$MODEL")
[ "$NO_COMPANION_CHECK" = 0 ] || ONBOARD_ARGS+=(--no-companion-check)
plan_companion() {
  PLAN_CODE=0
  node "$SCRIPT_DIR/scripts/onboard.mjs" "${ONBOARD_ARGS[@]}" > "$plan_file" || PLAN_CODE=$?
  if ! jq -e '.configuration and .plan' "$plan_file" >/dev/null; then
    fail "Cannot inspect shared configuration; no changes applied."; exit 1
  fi
}
plan_companion
CURRENT="$(jq -r '.configuration.summary' "$plan_file")"
echo "Shared companion: $CURRENT"
jq -r '.companions[] | "  \(.displayName): " + (if .ready then "ready" else "not ready" end), (.blockers[], .warnings[] | "    " + .message), (.nextSteps[] | "    Next: " + .)' "$plan_file"
if jq -e '.plan.kind == "ask"' "$plan_file" >/dev/null; then
  read -r -p "Shared default companion [${COMPANION_IDS// /$slash}/none]: " COMPANION
  ONBOARD_ARGS+=(--companion "$COMPANION" --yes)
  if jq -e --arg id "$COMPANION" '.companions[$id].capabilities.modelSelection == true' "$plan_file" >/dev/null; then
    read -r -p "Default model for $COMPANION [Enter keeps saved model, inherit clears it]: " MODEL
    [ -z "$MODEL" ] || ONBOARD_ARGS+=(--model "$MODEL")
  fi
  plan_companion
fi
if [ "$PLAN_CODE" != 0 ]; then
  jq -r '.plan.message // "Selected companion is not ready. Fix its prerequisites, or explicitly use --no-companion-check."' "$plan_file"
  exit "$PLAN_CODE"
fi
CHOICE="$(jq -r 'if .plan.kind == "chosen" then .plan.id else "none" end' "$plan_file")"
if [ "$CHOICE" = none ]; then
  echo "Plan ($HOST): preserve companion configuration."
else
  echo "Plan ($HOST): set default companion to $CHOICE."
  if [ -z "$MODEL" ]; then echo "  Preserve model settings."; fi
  jq -r 'if .plan.ready then empty else "  Readiness deferred by --no-companion-check; companion is not ready." end' "$plan_file"
fi
echo "Intended installation changes:"
echo "  Install bridge-server dependencies in $SCRIPT_DIR/bridge-server."
echo "  Install or refresh the live-view launcher ~/.local/bin/agent-companion (runs this checkout's hooks/launch-ui.sh)."
if [ "$DO_CLAUDE" = 1 ]; then
  echo "  Merge companion permissions into ${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json."
  [ -z "${CLAUDE_CONFIG_DIR:-}" ] || echo "  Claude bridge records use $HOME/.claude/agent-companion; native transcripts use $CLAUDE_CONFIG_DIR/projects."
fi
if [ "$DO_CODEX" = 1 ]; then
  host_paths codex "$SCRIPT_DIR"
  echo "  Create $HOST_CONFIG_DIR if needed; refresh the Codex plugin and verify MCP."
  case "$UNLOAD_DELAY" in
    '') ;;
    default) echo "  Remove thread_unload_delay_secs from $HOST_CONFIG_DIR/config.toml (applies when Codex's daemon restarts)." ;;
    *) echo "  Set thread_unload_delay_secs to $UNLOAD_DELAY in $HOST_CONFIG_DIR/config.toml (applies when Codex's daemon restarts)." ;;
  esac
fi
if [ "$DO_OPENCODE" = 1 ]; then
  host_paths opencode "$SCRIPT_DIR"
  echo "  Register the OpenCode plugin from $SCRIPT_DIR/opencode-plugin."
  case "$OPENCODE_IDLE" in
    '') ;;
    default) echo "  Remove experimental.location_idle_timeout from the global config in $HOST_CONFIG_DIR." ;;
    *) echo "  Set experimental.location_idle_timeout to $OPENCODE_IDLE in the global config in $HOST_CONFIG_DIR." ;;
  esac
  [ -z "$OPENCODE_IDLE" ] || echo "  For an already running service, opencode reload applies the timeout to open directories after jobs finish."
fi
if [ "$DO_COPILOT" = 1 ]; then
  echo "  Register this checkout as a local Copilot marketplace and enable agent-companion."
  echo "  Enable experimental mode for the whole Copilot profile (copilot config experimental true)."
fi
echo "  Write diagnostic install markers after each host finishes."
if [ "$MODEL" = inherit ]; then
  echo "  Clear the shared default model for $CHOICE."
elif [ -n "$MODEL" ]; then
  echo "  Save shared default model $MODEL for $CHOICE."
fi
if [ -n "$MODEL" ]; then
  jq -r 'if .model.source == "env" then "  Effective model: \(.model.current) (environment override)." else empty end' "$plan_file"
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
  npm_action=install
  [ ! -f "$BRIDGE_DIR/package-lock.json" ] || npm_action=ci
  echo "  Running npm $npm_action --no-audit --no-fund in $BRIDGE_DIR"
  (cd "$BRIDGE_DIR" && npm "$npm_action" --no-audit --no-fund) || {
    code=$?
    fail "npm $npm_action --no-audit --no-fund exited $code in $BRIDGE_DIR"
    exit "$code"
  }
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

if [ "$DO_CLAUDE" = 1 ]; then
  STEP="Claude permissions"
  printf "=== Claude Code host install ===\n"
  host_paths claude "$SCRIPT_DIR"

  # 5b. Permission allow-list — without an explicit allow rule, the first
  # invocation of a agent-bridge MCP tool can surface a permission
  # prompt. Plugin-shipped settings.json cannot declare permissions, so
  # we merge into the user's ~/.claude/settings.json.
  printf "Granting Claude companion permissions in ${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json...\n"
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
  # bridge transport.
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
  ok "Codex agent-bridge MCP registration verified"

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

if [ "$DO_OPENCODE" = 1 ]; then
  STEP="OpenCode plugin"
  host_paths opencode "$SCRIPT_DIR"
  plugin="$SCRIPT_DIR/opencode-plugin"
  if output=$(opencode plugin add "$plugin" 2>&1); then
    ok "$output"
  elif [[ "$output" == *"Plugin target must be an npm registry package or Git package specifier"* ]]; then
    # OpenCode 2.3.2 discovers local packages under plugins/ but rejects
    # checkout paths on its plugin-add command line.
    local_plugin="$HOST_CONFIG_DIR/plugins/agent-companion"
    mkdir -p "$HOST_CONFIG_DIR/plugins"
    if ! [ "$plugin" -ef "$local_plugin" ]; then
      if [ -e "$local_plugin" ] || [ -L "$local_plugin" ]; then
        fail "Another plugin already occupies $local_plugin"; exit 1
      fi
      ln -s "$plugin" "$local_plugin"
    fi
    ok "registered local OpenCode plugin: $local_plugin"
  else
    fail "$output"; exit 1
  fi
  OPENCODE_STATUS="plugin registered; host setup pending"
  if [ -n "$OPENCODE_IDLE" ]; then
    STEP="OpenCode global idle timeout"
    node "$idle_writer" "$OPENCODE_IDLE"
    warn "OpenCode reloads open directories and their MCP servers on 'opencode reload'."
  fi
  mkdir -p "$HOST_STATE_DIR"
  printf 'opencode\n' > "$HOST_STATE_DIR/.host"
  OPENCODE_STATUS=installed
fi

if [ "$DO_COPILOT" = 1 ]; then
  STEP="Copilot plugin installation"
  host_paths copilot "$SCRIPT_DIR"
  check_copilot_market
  [ -n "$market" ] || copilot plugin marketplace add "$SCRIPT_DIR"
  COPILOT_STATUS="marketplace registered; plugin pending"
  AGENT_COMPANION_HOST=copilot CLAUDE_PLUGIN_ROOT="$SCRIPT_DIR" AGENT_COMPANION_REQUIRE_DEPS=1 /bin/bash "$SCRIPT_DIR/hooks/install-deps.sh"
  copilot config experimental true
  copilot plugin install agent-companion@agent-companion
  mkdir -p "$HOST_STATE_DIR"
  printf 'copilot\n' > "$HOST_STATE_DIR/.host"
  COPILOT_STATUS=installed
fi

# --- Syntax-check all .mjs files ------------------------------------

STEP="syntax checks"
printf "Syntax-checking scripts...\n"
source_files() {
  (cd "$SCRIPT_DIR" && find ./bridge-server ./extensions ./hooks ./lib ./opencode-plugin ./probes ./scripts ./test \
    \( -name node_modules -o -name dist -o -name .plugin-data \) -prune -o -type f -name "$1" -print0)
}
source_files '*.mjs' > "$PLAN_DIR/sources"
if ! (cd "$SCRIPT_DIR" && xargs -0 -P 4 -n 1 node --check < "$PLAN_DIR/sources"); then
  fail "Source syntax check failed (see Node diagnostic above)."
  exit 1
fi
count=$(tr -cd '\000' < "$PLAN_DIR/sources" | wc -c)
ok "Syntax checked $((count)) source files."
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
source_files '*.test.mjs' > "$PLAN_DIR/tests"
while IFS= read -r -d '' f; do EXISTING+=("$SCRIPT_DIR/$f"); done < "$PLAN_DIR/tests"

if [ "${#EXISTING[@]}" -gt 0 ]; then
  if node --test --test-timeout=300000 "${EXISTING[@]}" 2>/dev/null; then
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
if [ "$CHOICE" != none ]; then
  ONBOARD_ARGS=(--host "$HOST" --companion "$CHOICE" --set-default --yes --json)
  [ -z "$MODEL" ] || ONBOARD_ARGS+=(--model "$MODEL")
  [ "$NO_COMPANION_CHECK" = 0 ] || ONBOARD_ARGS+=(--no-companion-check)
  if node "$SCRIPT_DIR/scripts/onboard.mjs" "${ONBOARD_ARGS[@]}" > "$PLAN_DIR/result.json"; then
    CURRENT="$(jq -r '.configuration.summary' "$PLAN_DIR/result.json")"
    jq -r 'if .ok then empty else "Companion readiness deferred; fix prerequisites before delegating." end' "$PLAN_DIR/result.json"
  else
    jq -r '(.report.blockers[]?.message), (.report.nextSteps[]? | "Next: " + .)' "$PLAN_DIR/result.json" 2>/dev/null || true
    fail "Companion configuration failed; previous configuration preserved. Fix prerequisites and rerun."
    exit 1
  fi
fi
