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
   - Done in `5172d2f`: add a small runtime interface for `send`, `wait`, `status`, `reply`, and `cancel`.
   - Done in `5172d2f`: keep the current ACP daemon as the default adapter.
   - Done in current SDK phase: add `COPILOT_RUNTIME_ADAPTER=sdk` behind an explicit opt-in flag.
   - Current SDK behavior: preserve the existing reply contract with cancel-and-restart; native SDK `mode:"immediate"` steering is a later API/UI decision.
   - Direct bridge smoke passed for both `acp` and `sdk` with `gpt-5-mini`: `send` -> `wait` completed, digest path generated, verbose `status` inspected.
   - SDK smoke findings: `gpt-4.1` was not available in this local SDK account/runtime, and model-specific reasoning effort must stay opt-in.
   - Next: keep ACP as default until full Claude-host and Codex-host end-to-end smokes pass.

2. MCP resource polish
   - Done in current MCP resource phase: expose digest files through MCP `resources/list`, `resources/templates/list`, `resources/read`, and tool-result `resource_link` blocks.
   - File paths intentionally remain in responses until both Claude and Codex resource UX is verified.
   - Next: run full Claude-host and Codex-host resource reads from real companion turns, then decide whether digest paths can become debug-only.

3. MCP tool-surface split
   - Done in current tool-split phase: replaced the public multiplexed `copilot` tool with separate tools:
     `copilot_send`, `copilot_wait`, `copilot_status`, `copilot_reply`, `copilot_cancel`.
   - The server still uses the action-based dispatcher internally; the public MCP layer injects the action from the tool name.
   - Next: verify Claude and Codex host tool registration, permission prompts, and subagent instructions against the split surface.

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
