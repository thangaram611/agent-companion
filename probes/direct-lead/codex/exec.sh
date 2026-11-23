#!/bin/bash
# Run one headless Codex turn in a prepared run. Usage: exec.sh RUN "prompt" [seconds]
RUN="$1"; PROMPT="$2"; WALL="${3:-120}"
cd "$RUN/workspace" && env -i PATH="$PATH" HOME="$RUN/home" CODEX_HOME="$RUN/codex-home" TMPDIR="$RUN/tmp" LANG=en_US.UTF-8 \
  perl -e 'alarm shift; exec @ARGV' "$WALL" codex exec $CODEX_EXTRA --skip-git-repo-check -C "$RUN/workspace" "$PROMPT" < /dev/null >> "$RUN/exec.out" 2>&1
echo "exit=$?"
