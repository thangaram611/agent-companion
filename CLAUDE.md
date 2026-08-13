# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A delegation plugin: a **harness** (Claude Code or Codex CLI) spawns an isolated
`agent-companion` subagent, which owns a private `agent-bridge` MCP server, which runs the work
on a **companion** runtime (OpenCode, GitHub Copilot CLI, or Codex CLI). The parent agent never
sees the bridge tools. The matrix is 2 harnesses × 3 companions, and two of the companions ship
two transports each — parity across that matrix is the product, not an implementation detail.

Read `README.md` for the user-facing contract and `docs/ARCHITECTURE.md` before any non-trivial
change. `docs/ARCHITECTURE.md` carries a **Negative Results** section: things that look wrong
in this code but are deliberate because a measurement overturned the obvious design. Check it
before "fixing" something surprising — each entry cost about a day to derive.

## Commands

Dependencies (only `bridge-server/` has a `package.json`; there are no npm scripts):

```bash
cd bridge-server && npm ci --no-audit --no-fund
```

Full check, matching CI (`.github/workflows/ci.yml`):

```bash
bash -n setup.sh hooks/*.sh
find . -name '*.mjs' -not -path './bridge-server/node_modules/*' -print0 | xargs -0 -n1 node --check
find . -name '*.test.mjs' -not -path './bridge-server/node_modules/*' -print0 | xargs -0 node --test
cd bridge-server && npm audit --omit=dev --audit-level=moderate
```

Test discovery must start at the repo root, not an allowlist of directories — an allowlist
silently omits `test/`, so both cross-cutting guard suites never run. Measured 2026-08-13: the
root-anchored form discovers 39 files, an allowlist without `test/` discovers 37. README's
*Development* section, `docs/RELEASE_READINESS.md`'s release gates and `docs/MVP_TRACKER.md`'s
*Validation Commands* all use the root-anchored form; keep it that way.

One file / one test:

```bash
node --test lib/state.test.mjs
node --test --test-name-pattern 'default-target is unset' lib/state.test.mjs
```

Diagnostics and onboarding (also the fastest way to see live config):

```bash
node scripts/doctor.mjs [--json]
node scripts/onboard.mjs --list-targets | --doctor | --list-profiles
node scripts/onboard.mjs --target opencode --set-default        # AGENT_COMPANION_HOST=claude|codex to scope
```

Install a harness surface from this checkout (idempotent):

```bash
bash setup.sh --host claude|codex|both --target opencode|copilot|codex|auto|none [--skip-tests]
```

Packaging validation:

```bash
node scripts/build-codex-marketplace.mjs --out dist/codex-marketplace
node scripts/validate-codex-release.mjs      # end-to-end in an isolated CODEX_HOME
claude plugin validate .
```

Regenerate the pinned codex wire contract (the only sanctioned way that fixture changes; then
read the diff — a moved thread id is a live misrouting bug):

```bash
node scripts/gen-codex-app-server-contract.mjs
```

`probes/` are **not** tests — hand-run harnesses that spawn real `codex` runs and cost tokens.
See `probes/README.md`; re-run them when the codex CLI or Claude Code is upgraded.

## Architecture

```
harness (claude|codex)
  └─ agent-companion subagent          templates/agent-companion.{md,toml}
       └─ agent-bridge MCP server      bridge-server/server.mjs   (spawned per invocation)
            ├─ resolveRouting          → one profile → {companion, model, adapter}
            └─ adapter                 bridge-server/<companion>[-<transport>]-runtime.mjs
                 └─ detached shared runtime, when the transport has one
                      copilot-acp-daemon | opencode serve | codex-app-server-broker
```

**Layers.** `lib/` is host-neutral and importable from both the MCP server and standalone CLI
scripts. `bridge-server/` is the MCP server plus one file per companion×transport.
`scripts/` holds the long-lived daemons and the install/onboard/package CLIs. `hooks/` holds
lifecycle shell hooks for both harnesses.

**The bridge is disposable; the runtimes are not.** The bridge process is spawned inline from
the subagent's frontmatter and has no activation lifecycle. Concurrent subagents *share one
bridge process*, and that process is SIGINT'd when the **first** of them finishes. Anything that
must outlive a subagent therefore lives in a detached, machine-wide runtime with its own socket,
never in bridge memory. This is the single most load-bearing fact in the repo.

**No silent fallback, anywhere.** An unresolvable send returns an explicit `ok:false` envelope
(`TARGET_UNCONFIGURED`, `TARGET_UNSUPPORTED`, `STRENGTH_UNCONFIGURED`, `STRENGTH_AMBIGUOUS`,
`PROFILE_UNKNOWN`, `PROFILE_AMBIGUOUS`, `ROUTING_CONFLICT`, `CAPABILITY_UNAVAILABLE`,
`MODEL_NOT_ALLOWED`). Treat that list as closed — both agent templates enumerate all nine, and
both forbid the subagent from re-sending with a target the harness never supplied. Both template
suites pin the list, so a new code must land in four places: `resolveRouting`, both templates,
and both template suites. The envelope echoes candidate ids only where candidates exist; the
capability-gate refusals (`TARGET_UNSUPPORTED`, `CAPABILITY_UNAVAILABLE`, `MODEL_NOT_ALLOWED`)
carry none.

**Capability-driven where a capability exists.** Reply, resume, `serverMode`, and model
selection are per-companion×transport capabilities resolved from `lib/target-registry.mjs`;
prefer a registry lookup over a companion-id branch when adding to that set. Two exceptions are
real and worth knowing before you generalize: there is no `streaming` capability key at all, and
`capabilities.parallel` is declared but read by nothing — the fleet decision is a literal
`target === 'copilot' && shouldUseFleet(...)` branch (`bridge-server/server.mjs:2859`).
Per-job `reply_available` / `resume_available` pin **opencode and codex** to the adapter the job
started with (`opencodeAdapter` / `codexAdapter`); copilot has no recorded per-job adapter and
re-reads live `COPILOT_RUNTIME_ADAPTER` on every call (`server.mjs:898`).

## Single-source-of-truth modules

Consolidation here is enforced, in several cases by tests that grep the source tree. Adding a
second reader/definition is how these break.

| Module | Owns |
| --- | --- |
| `lib/host.mjs` | The only place that chooses claude-vs-codex conventions. `AGENT_COMPANION_HOST` is authoritative; `.host` marker files are diagnostic only, never a fallback. |
| `lib/state.mjs` | All durable state under `~/.{claude,codex}/agent-companion/`. Atomic tmp+rename, 0600. |
| `lib/runtime-paths.mjs` | All transient runtime paths — logs, sockets, prompt streams, digests. |
| `lib/target-registry.mjs` | What a companion can do (capabilities) **and** what it takes to be ready (onboarding). Two concerns, one descriptor, deliberately. |
| `lib/profile-registry.mjs` | The **only** reader of `profiles.json`. `test/profile-registry-guard.test.mjs` fails on any other reference to `readProfilesRaw` / `PROFILES_FILE`. |
| `lib/target-diagnostics.mjs` | `probeCommand` is the **only** sanctioned synchronous shell-out from bridge code. `test/exec-timeout-guard.test.mjs` fails on any new unbounded one — an unbounded probe wedges every in-flight job on that bridge. |
| `lib/shared-runtime-registry.mjs` | Leases + two-phase disposal for machine-wide runtimes. A `dispose` that does anything before the destructive act must call `confirmDisposal()` as late as possible and abort when it returns false. |
| `lib/codex-app-server-contract.json` | The pinned `codex app-server` wire contract. **Generated** — change it only via `scripts/gen-codex-app-server-contract.mjs`; the sibling test re-derives it and fails on drift. Test fakes build every frame through it, so a fixture claiming a field the schema does not declare fails to build. |
| `lib/codex-app-server-contract.mjs` | Hand-written: the loader, `distillAppServerSchema`, `serializeContract`, and the routing / contract-violation checkers. The generator imports it, so edit here to change a distillation rule or add a check. |
| `resolveRouting` (`bridge-server/server.mjs`) | The sole SEND routing brain. |

## Things that will bite you

- **`templates/` is the source; the installed copy is generated.** `hooks/install-agent.sh`
  re-materializes `~/.claude/agents/agent-companion.md` on *every* session start, unconditionally.
  Edits to the installed copy are silently discarded. (A destination lacking the AUTO-INSTALLED
  sentinel is treated as hand-authored and left alone forever.)
- **Host parity is a test, not a convention.** The two templates configure the same bridge
  through different mechanisms (YAML `env:` + `timeout` in ms vs TOML `env = {}` +
  `tool_timeout_sec` in seconds). Mechanism may diverge; capability may not —
  `templates/host-parity.test.mjs` enforces it. A knob documented only in a comment counts as
  *not set*.
- **MCP timeouts:** the working fields are a **sibling** `timeout:` on the Claude server entry
  (ms) and `tool_timeout_sec` in the Codex TOML. `env: { MCP_TOOL_TIMEOUT }` reaches the child
  and is ignored by the host. Never raise `clampWaitSec` past 1500 s without a per-server
  `timeout`.
- **Tests sandbox `$HOME` by env** — `process.env.AGENT_COMPANION_HOME = mkdtempSync(...)`, plus
  `AGENT_RUNTIME_DIR` for runtime paths. Only `lib/state.mjs` binds at import time (`BASE_DIR`,
  line 27), so a suite touching **state** must set the env and then `await import('./x.mjs')`.
  `lib/runtime-paths.mjs` and `lib/log.mjs` re-read their env per call — deliberately, so a
  statically-importing suite can redirect them — and four shipped suites sandbox that way with
  plain top-level imports.
- **`bridge-server/server.test.mjs`'s fake-OpenCode-CLI test is timing-sensitive** (a 5 s poll
  budget). It has been observed failing under full-suite concurrency and passing in ~0.6 s alone
  — re-run the file before treating it as a real regression.
- **Naming:** the product identity is uniformly `agent-*` with no back-compat shims
  (`agent-bridge`, `agent-digest://`, `AGENT_COMPANION_*`). `copilot-*` identifiers name the
  Copilot *adapter*, not the product, and stay as they are.
- **Codex sandbox defaults are deliberately not codex's defaults** (`workspace-write` with
  network **on**), and under the app-server transport `approvalPolicy: 'never'` is structural —
  accepting one approval was measured escalating past the sandbox. Do not make it configurable.

## Docs

| File | Use |
| --- | --- |
| `docs/ARCHITECTURE.md` | Layer boundaries, routing contract, state layout, **Negative Results**. |
| `docs/RELIABILITY_REMEDIATION.md` | The measured evidence behind the codex/app-server design. Cited by name from source comments. |
| `docs/MVP_TRACKER.md` | What is done, what the current limitations are, what is next. |
| `docs/RELEASE_READINESS.md` | Release gates and source-backed vendor compatibility notes. |
| `docs/STRENGTH_ROUTING_HANDOFF.md`, `docs/ONBOARDING_HANDOFF.md` | Design records for the profile/strength router and onboarding. |
| `probes/README.md` | What each probe proves, and the dead ends already ruled out. |

Commit subjects follow `type(scope): lowercase description of what changed and why`, often with
two clauses joined by "and".
