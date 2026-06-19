#!/bin/bash
# install-deps.sh — SessionStart hook
#
# Ensures bridge-server's node_modules is installed and reachable from the
# plugin root's bridge-server/. Idempotent, concurrent-safe (flock),
# lockfile-aware (sha256 of package.json + package-lock.json).
#
# NODE_PATH does NOT work for ESM bare imports (Node >= 22 — verified
# empirically). We install to plugin data when the host provides it for update
# persistence and symlink it into the plugin root's bridge-server/ so
# ESM's ancestor-directory resolver finds the deps.
#
# Exits silently on the fast path. Emits a one-line summary on install; writes
# full npm output to install.log.

ROOT="${CLAUDE_PLUGIN_ROOT:-${PLUGIN_ROOT:-}}"
[ -n "$ROOT" ] || exit 0

TOOLS="$ROOT/hooks/node-tools.sh"
if [ -r "$TOOLS" ]; then
  # shellcheck source=/dev/null
  . "$TOOLS"
fi
NODE_BIN="$(resolve_node 2>/dev/null || true)"
if [ -n "$NODE_BIN" ]; then
  export PATH="$(dirname "$NODE_BIN"):${PATH:-}"
fi
NPM_BIN="$(resolve_npm 2>/dev/null || true)"
if [ -z "$NPM_BIN" ]; then
  echo "agent-companion: npm not found; cannot install bridge dependencies" >&2
  exit 1
fi

# CLAUDE_PLUGIN_DATA/PLUGIN_DATA is only populated for marketplace-installed plugins.
# For --plugin-dir local-dev runs, fall back to a sibling dir under the
# plugin root (not pretty, but keeps local-dev functional).
DATA="${CLAUDE_PLUGIN_DATA:-${PLUGIN_DATA:-$ROOT/.plugin-data}}"

BUNDLED_PKG="$ROOT/bridge-server/package.json"
BUNDLED_LOCK="$ROOT/bridge-server/package-lock.json"
PERSIST_DIR="$DATA/bridge-server"
MANIFEST_HASH="$PERSIST_DIR/.manifest.sha256"
SYMLINK="$ROOT/bridge-server/node_modules"
LOG="$PERSIST_DIR/install.log"

[ -f "$BUNDLED_PKG" ] || exit 0

mkdir -p "$PERSIST_DIR"

# Concurrent-install guard. Two sessions starting within seconds of each
# other would otherwise race `npm install` against the same target and
# corrupt node_modules. Portable mutex via atomic `mkdir` (macOS lacks
# `flock` by default). Second process waits up to 60s; if the lock is
# stale (holder PID dead) it reclaims. Trap cleans up on exit.
LOCK_DIR="$PERSIST_DIR/.install.lock.d"
WAIT=60
while [ "$WAIT" -gt 0 ]; do
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    echo "$$" > "$LOCK_DIR/pid"
    trap 'rm -rf "$LOCK_DIR"' EXIT
    break
  fi
  HOLDER=$(cat "$LOCK_DIR/pid" 2>/dev/null)
  if [ -n "$HOLDER" ] && ! kill -0 "$HOLDER" 2>/dev/null; then
    # Holder process is gone — lock is stale.
    rm -rf "$LOCK_DIR"
    continue
  fi
  sleep 1
  WAIT=$((WAIT - 1))
done
if [ ! -d "$LOCK_DIR" ] || [ "$(cat "$LOCK_DIR/pid" 2>/dev/null)" != "$$" ]; then
  # Couldn't acquire in 60s — another SessionStart holds it; it'll finish
  # the install on our behalf. Exit cleanly so the hook banner stays green.
  exit 0
fi

hash_files() {
  if command -v sha256sum >/dev/null 2>&1; then
    cat "$@" 2>/dev/null | sha256sum | cut -d' ' -f1
  else
    cat "$@" 2>/dev/null | shasum -a 256 | cut -d' ' -f1
  fi
}

# Hash covers both package.json and package-lock.json so transitive-only
# lockfile changes (npm audit fix, peer bumps) trigger reinstall.
if [ -f "$BUNDLED_LOCK" ]; then
  EXPECT_HASH=$(hash_files "$BUNDLED_PKG" "$BUNDLED_LOCK")
else
  EXPECT_HASH=$(hash_files "$BUNDLED_PKG")
fi

STORED_HASH=""
[ -f "$MANIFEST_HASH" ] && STORED_HASH=$(tr -d '[:space:]' < "$MANIFEST_HASH")

# Fast path: node_modules present, hash matches, symlink intact → no-op.
if [ -d "$PERSIST_DIR/node_modules" ] \
    && [ "$EXPECT_HASH" = "$STORED_HASH" ] \
    && [ -L "$SYMLINK" ]; then
  exit 0
fi

# Copy manifest into DATA so `npm ci` / `npm install` can run there.
cp "$BUNDLED_PKG" "$PERSIST_DIR/package.json"
if [ -f "$BUNDLED_LOCK" ]; then
  cp "$BUNDLED_LOCK" "$PERSIST_DIR/package-lock.json"
fi

# Prefer `npm ci` when a lockfile is present: it wipes node_modules first, so
# a killed prior install (SessionStart timeout) can't leave corrupt state.
if [ -f "$PERSIST_DIR/package-lock.json" ]; then
  INSTALL_ARGS=(ci --silent --no-audit --no-fund)
else
  INSTALL_ARGS=(install --silent --no-audit --no-fund)
fi

cd "$PERSIST_DIR" || { echo "agent-companion: cd $PERSIST_DIR failed" >&2; exit 1; }
if ! "$NPM_BIN" "${INSTALL_ARGS[@]}" >"$LOG" 2>&1; then
  rm -f "$MANIFEST_HASH"
  echo "agent-companion: npm install failed (see $LOG)" >&2
  exit 1
fi

# (Re)create symlink in ROOT so ESM finds node_modules via ancestor-walk from
# the server.mjs importer. Plugin updates move ROOT, so the symlink is always
# re-made on the first session after an update.
rm -rf "$SYMLINK" 2>/dev/null
ln -s "$PERSIST_DIR/node_modules" "$SYMLINK"

echo "$EXPECT_HASH" > "$MANIFEST_HASH"
echo "agent-companion: deps ready"
exit 0
