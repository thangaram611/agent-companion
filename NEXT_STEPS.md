# Copilot Companion Next Steps

This file is the compaction-safe queue for work after the runtime hardening and
modern host-surface cleanup pass. Keep it current when starting or completing a
phase so future thread resumes do not depend on chat history.

## Completed Baseline

- Private per-host runtime root added under `~/.{claude,codex}/copilot-companion/runtime/`.
- `parallel` changed to `"auto" | "always" | "never"` with heuristic `/fleet` default.
- MCP validation failures now return structured `isError` tool results.
- Node baseline raised to `>=22`; deprecated GPT-5.2 model entries removed.
- `scripts/doctor.mjs` added for environment diagnostics.

Verified before commit:

```bash
node --test $(find bridge-server lib scripts hooks templates -path '*/node_modules' -prune -o -type f -name '*.test.mjs' -print)
while IFS= read -r f; do node --check "$f" >/dev/null || exit 1; done < <(find bridge-server lib scripts hooks templates -path '*/node_modules' -prune -o -type f -name '*.mjs' -print)
node scripts/doctor.mjs --json
npm audit --omit=dev --json
claude plugin validate .
```

## Next Phase Queue

1. Copilot runtime adapter
   - Done in post-`59ab301` worktree: add a small runtime interface for `send`, `wait`, `status`, `reply`, and `cancel`.
   - Done in post-`59ab301` worktree: keep the current ACP daemon as the default adapter.
   - Next: add a Copilot SDK adapter behind an explicit config flag.
   - Run side-by-side smoke tests before making SDK the default.

2. MCP resource polish
   - Expose digest files through MCP resources or `resource_link` results.
   - Keep file paths in responses until both Claude and Codex behavior is verified.

3. MCP tool-surface split
   - Evaluate replacing the multiplexed `copilot` tool with separate tools:
     `copilot_send`, `copilot_wait`, `copilot_status`, `copilot_reply`, `copilot_cancel`.
   - Only split if host UX, schema precision, or permissions improve enough to justify it.

4. Published packaging
   - Finalize Codex marketplace packaging and decide whether lifecycle hooks should be
     plugin-scoped there instead of dev-materialized into `~/.codex/hooks.json`.
   - Re-check Claude marketplace packaging after `defaultEnabled: false`.

5. Live end-to-end smoke
   - Run one Claude-host delegation and one Codex-host delegation in a disposable repo.
   - Verify runtime files land in the private runtime dir.
   - Verify completion drain, digest generation, cancel, reply, and timeout messaging.

## Guardrails

- Do not reintroduce shared `/tmp` defaults for IPC, queues, prompt streams, digests, or logs.
- Do not restore boolean `parallel`; use only `"auto"`, `"always"`, or `"never"`.
- Do not pin deprecated GPT-5.2 model names.
- Treat Copilot ACP as preview; keep defensive capability probing.
- Treat Copilot SDK as experimental until live behavior matches the ACP adapter.
