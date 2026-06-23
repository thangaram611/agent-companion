# Strength-Routed Companion Profiles — Implementation Handoff

Last updated: 2026-06-23

> **Status: IMPLEMENTED (2026-06-23).** Shipped across phases P1–P5 with the
> committed regressions green (`lib/profile-registry.mjs`, `resolveRouting` in
> `bridge-server/server.mjs`, doctor/status/onboard wiring, and templates). This
> document is retained as the design record; the prescriptive plan below matches
> the as-built code. It was produced by a multi-agent design pass (understand →
> 4 independent architectures → judge panel → synthesize → adversarial critique →
> finalize), then finalized with the repo owner. The critic corrected three
> load-bearing errors during design (OpenCode per-profile model was "validated
> then silently ignored"; the Copilot `.sid` file is keyed by thread name alone;
> the reattach guard returns a `status`, not a `code`) — all three are handled in
> the shipped code.

## Objective

Move routing from one-to-one (`agent_send` names a concrete companion `target`)
to **one-to-many companion profiles routed by strength**:

- A **profile registry** represents multiple profiles per companion, including
  multiple model profiles from the same runtime.
- Profiles declare **strengths** (`reviewer`, `web_researcher`, `planner`,
  `fast_executor`).
- A harness routes by passing a **strength** (preferred) or **profile** id — it
  never needs to know companion or model ids.
- Onboarding / doctor / status show configured strengths and profile readiness.
- Every unresolvable/ambiguous send returns an explicit `ok:false` error — **no
  silent fallback**, mirroring the existing `TARGET_UNCONFIGURED` posture.

## Finalized Decisions (owner-confirmed 2026-06-23)

1. **Precedence — constraint-consistency.** `profile` and `strength` are mutually
   exclusive (pass at most one). An explicit `target` MAY co-exist with
   `strength`/`profile` as a *refinement*; if the resolved profile's companion
   disagrees with the explicit `target`, return `ROUTING_CONFLICT`. Pure priority
   ordering is rejected (it would silently ignore a supplied dimension).
2. **Strength tiebreak — authored via `defaultProfile`.** Multiple profiles may
   declare the same strength. The top-level `defaultProfile` wins **only if it
   itself declares that strength**; otherwise the tiebreak is *inert* and the send
   returns `STRENGTH_AMBIGUOUS` (echoing the candidate ids). A per-profile numeric
   `priority` field is **reserved** as a documented future hook, not shipped.
3. **Strength semantics — empty capability map (v1).** None of the four strengths
   intrinsically demands `reply`/`resume`/`streaming`/`parallel`. Ship
   `STRENGTH_CAPABILITY_REQUIREMENTS = {reviewer:[], web_researcher:[], planner:[],
   fast_executor:[]}`. The map is fully wired into the capability gate and doctor
   but is a no-op in v1; populating it later enforces a requirement pre-spawn with
   zero other changes. Reply-availability stays caught by the existing
   `jobReplyAvailable` at reply time.
4. **On-disk format — plain unversioned `profiles.json`.** No `schemaVersion` /
   migration-chain machinery. Adding a top-level version field later is itself
   backward-compatible (absent ⇒ v1).
5. **Field schema — open string, server-validated** (adopted default). `strength`
   and `profile` are open-string fields on `agent_send`, not closed JSON-Schema
   enums (a closed enum would freeze the per-install vocabulary into the public
   MCP contract). `validation.mjs` still does a synchronous closed-set check
   against `VALID_STRENGTHS`; registry membership is enforced server-side with a
   deterministic candidate-echoing error.
6. **Onboarding — thin writer + validate/report** (adopted default). Ship
   `--define-profile` as a non-interactive append writer plus robust
   `--list-profiles`/validation; defer an interactive wizard.
7. **Sid collision fix — namespace the Copilot `.sid` by profile** (adopted
   default; critic-verified). See "Sequential thread/sid collision" below.

## Core Architecture

**Primary design: capability-driven router-first**, grafted with single-producer
discipline (one reader of `profiles.json`), an id-free strengths view for
harnesses, and the restraint that legacy synthesis lives only in the resolve path.

- A new pure module `lib/profile-registry.mjs` owns **one producer**,
  `loadProfiles({env})` — the **only** reader of `profiles.json`. It returns a
  normalized object:
  `{ profiles, byId:Map, byStrength:Map<strength,[profileId]>, defaultProfile:{value,source}|null, loadErrors, synthesized:boolean }`.
  Every consumer (`resolveRouting`, doctor, status, onboard, diagnostics)
  **projects** from this object; nothing else opens the file.
- A **profile** is `{ id, companion (∈ TARGET_IDS), model?, strengths[], adapter? (opencode-only) }`.
  Profiles **inherit** capabilities via `getTarget(profile.companion)` +
  `applyAdapterCapabilities` (`lib/target-registry.mjs:143-151`) — they never
  re-declare capability booleans. **Capability is companion/adapter-level; model
  is profile-level and does not change capabilities.**
- For an opencode profile with `adapter:'server'`, `loadProfiles` overlays
  `{OPENCODE_RUNTIME_ADAPTER:'server'}` *synthetically* into the env passed to
  `applyAdapterCapabilities` for that profile's capability resolution only —
  never mutating `process.env`.

### The chokepoint

`resolveTargetId(args.target)` (`bridge-server/server.mjs:413-415`, called at
`:1763`) generalizes into `resolveRouting({target, profile, strength}, env)`,
returning `{ok:true, resolved:{profileId, companion, model, strengths, capabilities, adapter}}`
or `{ok:false, code, candidates?, profiles}`. It is the **sole SEND routing
brain** and the only place precedence, conflict detection, and the pre-spawn
capability gate live.

> Parallel-path guard (critic-verified): `defaultTargetId()` / `normalizeTargetId()`
> are also reachable from the display-only instructions string at
> `server.mjs:2243` and inside `getTarget`. A P2 acceptance test must assert that
> **no send-path caller** of `normalizeTargetId`/`getTarget` bypasses
> `resolveRouting`. The `:2243` instructions read is display-only and stays.

### Config schema — `profiles.json`

File: `$BASE_DIR/profiles.json` where `BASE_DIR = AGENT_COMPANION_HOME ||
companionHomeDir(detectHost())` (so `~/.claude` and `~/.codex` trees stay
independent). Read/written via the **jobs JSON pattern**: `atomicWrite`
(tmp `.agent-<hex>.tmp` → `renameSync`, chmod `0600`, `ensureDir 0700`) and
`readFileSafe` + `JSON.parse` returning `null` on missing/corrupt (a whole-file
parse error degrades to synthesis, never throws).

```jsonc
{
  "profiles": [
    { "id": "cop-review",  "companion": "copilot",  "model": "claude-sonnet-4.6",        "strengths": ["reviewer", "planner"] },
    { "id": "cop-fast",    "companion": "copilot",  "model": "claude-haiku-4.5",         "strengths": ["fast_executor"] },
    { "id": "oc-research", "companion": "opencode", "model": "anthropic/claude-sonnet-4.6", "adapter": "server", "strengths": ["web_researcher"] }
  ],
  "defaultProfile": "cop-review"
}
```

Field rules (validated at load by `loadProfiles`; a per-profile violation
**drops that profile** with a `loadError` surfaced by doctor; a whole-file parse
error → synthesis path):

- `id`: `^[a-z0-9][a-z0-9._-]{0,63}$`, unique, lowercased. **Must also be a valid
  thread-slug** (`[a-zA-Z0-9._-]`) because the Copilot sid file is now namespaced
  `<thread>__<profileId>.sid`. The id charset already satisfies `threadPath`'s
  regex.
- `companion`: **required**, ∈ `TARGET_IDS` (`opencode`|`copilot`). Unknown →
  profile dropped with `loadError`.
- `model`: optional. Validated **lazily** at send/readiness by
  `isModelAllowedFor(companion, model)`, not at load. Absent → companion default.
  **For opencode, `model` is a load-time/`CAPABILITY_UNAVAILABLE` rejection until
  the worker model-plumbing (below) is verified** — never validated-then-ignored.
- `strengths`: optional array, each ∈ `VALID_STRENGTHS`, lowercased + de-duped.
  Unknown label dropped with `loadError`.
- `adapter`: optional, opencode-only, `'cli'|'server'`. Copilot must be
  null/absent (else `loadError`). `'server'` overlays `OPENCODE_RUNTIME_ADAPTER`
  for this profile's capability resolution only.
- `defaultProfile`: optional top-level id; the no-arg send winner **and** the
  authored tiebreak for an ambiguous strength. **Edge rules:** if it names a
  profile that does **not** claim an ambiguous strength, the tiebreak is *inert*
  for that strength → `STRENGTH_AMBIGUOUS` still fires. If it names a
  non-existent id → `loadError` (loud), never silently ignored.

`STRENGTH_CAPABILITY_REQUIREMENTS` (single-sourced const in
`lib/profile-registry.mjs`): `{reviewer:[], web_researcher:[], planner:[],
fast_executor:[]}` for v1 (empty = no capability demanded). Consumed by the
capability gate (STEP C) **and** `inspectProfile` so the two cannot disagree.

### `agent_send` contract

Two **new optional sibling fields** beside `target` — never overloaded into the
`target` enum. Both boundaries updated in lockstep.

1. **MCP inputSchema** (`server.mjs:2335` region, `additionalProperties:false` +
   `required:['cwd']` unchanged):
   - `strength`: open string. Description: *"Route to the configured profile that
     declares this capability label (e.g. reviewer, web_researcher, planner,
     fast_executor). Validated server-side against the live profile registry.
     Discover available strengths via {action:status}; do not hardcode. Mutually
     exclusive with profile."*
   - `profile`: open string. Description: *"Route to a specific configured profile
     id. Discover ids via {action:status, diagnostics:true}. Mutually exclusive
     with strength."*
   - `target` stays a closed enum.
2. **`validation.mjs`** (both boundary layers):
   - Add `'profile'`, `'strength'` to `ALLOWED_FIELDS.send` (`:88`).
   - Add `VALID_STRENGTHS = new Set(['reviewer','web_researcher','planner','fast_executor'])`,
     **imported from `lib/profile-registry.mjs`** so it is single-sourced (the
     validator imports only the set, never `loadProfiles`, staying
     socket/process/file-free).
   - In `validateSend` (`:503-532`): lowercase/trim both; reject `strength` not in
     `VALID_STRENGTHS` (`agent: strength must be one of reviewer|web_researcher|planner|fast_executor`);
     shape-check `profile` id (existence defers to server registry). **Enforce the
     public precedence rule here as a pure structural check:** strict
     mutual-exclusion of `{profile, strength}`
     (`agent: pass only one of profile or strength`); a `target` MAY co-exist
     (resolved server-side → `ROUTING_CONFLICT` on disagreement). Return adds
     `profile: profile||null, strength: strength||null`.

Wire payload (`templates/agent-companion.md` + `.toml`, **byte-identical
bodies**): document `"strength":"reviewer"|"web_researcher"|"planner"|"fast_executor"`
(and optional `"profile"`) beside the existing `"target"` key, plus one sentence:
*"Do not hardcode strengths — discover the configured set via {action:status};
never pass companion or model ids."* The `tools:` allow-list stays at the existing
5 `agent_*` + host tools (no growth). Both `.test.mjs` drift-lock tests extended.

### Resolution algorithm — `resolveRouting({target, profile, strength}, env)`

Reads only `loadProfiles(env)` output. Deterministic; no silent fallback.

**STEP A — count explicit inputs, apply constraint-consistency precedence:**
- 0 inputs: `defaultProfile` if set → resolve it; else if `profiles.json` absent →
  synthesize-from-defaults (back-compat); else see Empty/no-default edge below;
  else `TARGET_UNCONFIGURED` (unchanged wording, `server.mjs:1764-1774`).
- `profile` only: STEP B by id.
- `strength` only: STEP B by strength.
- `profile` + `strength`: `ROUTING_CONFLICT`.
- `target` + (`profile`|`strength`): resolve via STEP B, then if
  `resolved.companion !== target` → `ROUTING_CONFLICT`; if equal → OK refinement.
- `target` only: degenerate bare-target path (STEP B by target).

**STEP B — resolve to exactly one profile:**
- by id: `byId.get(id)`; missing → `PROFILE_UNKNOWN` (echo ids).
- by strength: `byStrength.get(label)`. 0 → `STRENGTH_UNCONFIGURED`. exactly 1 →
  that profile. >1 → if `defaultProfile` is one of the claimants, it wins; if
  `defaultProfile` is set but is **not** a claimant of this strength, the tiebreak
  is inert → `STRENGTH_AMBIGUOUS` (echo candidate ids; never a silent winner).
- by bare target: lone profile whose `companion===target`; if multiple, require
  `defaultProfile` among them or `PROFILE_AMBIGUOUS`; if `profiles.json` absent,
  synthesize.

**Empty/no-default edge (critic fix — was a back-compat regression).** Synthesis
fires **only** when `profiles.json` is null/parse-failed. Two newly-handled
present-but-unhelpful states: (i) a file that parses but every profile was dropped
(all-invalid) → EMPTY registry; (ii) a file with valid profiles but **no**
`defaultProfile` on a no-arg send. For both, if `default-target` is set, fall back
to the legacy bare-target resolution against `default-target` (so a hand-authored
`profiles.json` that omits `defaultProfile` but keeps `default-target` does not
newly fail) and emit a doctor **advisory** to add a `defaultProfile`. Only when
`default-target` is also unset → `TARGET_UNCONFIGURED`.

**STEP C — capability gate (pre-spawn, statically-knowable only).**
`caps = getTarget(resolved.companion, envWithAdapterOverlay).capabilities`.
Validate: copilot `model` → `isModelAllowedFor('copilot', model)` → model-not-allowed
envelope; opencode `model` → provider/model shape; `modelSelection:false`
companion pinning a model → `CAPABILITY_UNAVAILABLE`; `adapter:'server'` requested
but the server adapter is unavailable in env → `CAPABILITY_UNAVAILABLE`; any
non-empty `STRENGTH_CAPABILITY_REQUIREMENTS[strength]` missing from `caps` →
`CAPABILITY_UNAVAILABLE` naming the missing capability (no-op under the v1 empty
map). With v1, only model/adapter actually gate.

**OpenCode model plumbing (critic fix — high; was asserted-but-false).** Verified:
`runOpenCodeCliWorker` (`server.mjs:1416-1440`) calls `startOpenCodeRun` **without**
a model (`startOpenCodeRun` supports `model=` at `opencode-runtime.mjs:53/63` but
the worker never passes it); `runOpenCodeServerWorker` (`:1247`) passes
`resolveOpenCodeServerModel()` which reads **only** `env.AGENT_COMPANION_OPENCODE_MODEL`
(`opencode-server-runtime.mjs:56`). So a per-profile opencode model is currently
validated then **silently ignored**. **Required P2 sub-task:** thread
`resolved.model` through `runOpenCodeWorker(args)` →
`{runOpenCodeCliWorker, runOpenCodeServerWorker}` → `startOpenCodeRun({model})`
(cli) / `startOpenCodeServerPrompt({model})` (server, overriding the
`resolveOpenCodeServerModel` default with the per-job value). A committed
regression asserts a non-env opencode profile model reaches the spawn args for
**both** adapters. **Guardrail:** until that regression is green, an opencode
`profile.model` must be a `CAPABILITY_UNAVAILABLE` rejection — no-silent-fallback
holds even mid-implementation.

**Post-resolution.** Model block `@1861` reads `resolved.model` (gated by
`isModelAllowedFor`); job object `@1879` stores `profileId/model/strength/companion`
(**`job.target = companion`** is preserved so the dozens of `job.target||'copilot'`
reads at `364/439/576-589/2214/1808` keep working); worker dispatch `@1901` passes
the resolved `{companion, model, adapter}` into `runWorker`/`runOpenCodeWorker`.
Copilot model flows per-prompt into `runWorker({model})` (already plumbed `@1906`)
so the one ACP daemon serves all copilot model-profiles. Copilot sid **lookup** at
`1856-1859` passes `resolved.profileId` (sid namespacing). Reattach guard `@1808`
adds an `existing.profileId` comparison → `status:'profile_mismatch'` (a `status`,
**not** a code — see below).

**One-detached-server reuse.** Model is a per-prompt argument, never part of
server identity. Copilot daemon key stays `companion+adapter`; opencode server
pool keys on `baseUrl+directory`. Two profiles differing only by model reuse the
same detached server; sid namespacing keeps their Copilot sessions distinct.

### No-silent-fallback error codes

Resolution errors return the `TARGET_UNCONFIGURED` envelope shape:
`{ok:false, action:'send', code, error, targets:listTargets(), profiles:listProfilesPublic(), candidates?}`.
New codes: `STRENGTH_UNCONFIGURED`, `STRENGTH_AMBIGUOUS`, `PROFILE_UNKNOWN`,
`PROFILE_AMBIGUOUS`, `ROUTING_CONFLICT`, `CAPABILITY_UNAVAILABLE`. Existing
`TARGET_UNCONFIGURED`/`TARGET_UNSUPPORTED` unchanged.

> **Reattach-guard shape (critic fix — was contradictory).** The real in-flight
> guard (`server.mjs:1809-1822`) returns `{ok:false, status:'target_mismatch', ...}`
> — a `status` field, no `code`, no targets/profiles echo, with sibling
> `status:'cwd_mismatch'` (`:1828`). **Decision:** keep the reattach-guard family on
> its `status:*_mismatch` shape and add `PROFILE_MISMATCH` as a new
> `status:'profile_mismatch'` member, **exempt from the envelope rule**. Do not
> migrate the family to codes (that is an unflagged contract change its tests
> depend on). The envelope invariant therefore reads: *"every **resolution** error
> returns the `TARGET_UNCONFIGURED` envelope; the in-flight reattach guards are a
> separate `status:*_mismatch` family."*

### State & files (`lib/state.mjs` additions)

Host-routed under `BASE_DIR`; atomic `0600` / `ensureDir 0700`; reads return
`null`, never throw.

- `PROFILES_FILE = join(BASE_DIR,'profiles.json')`; `readProfilesRaw()` /
  `writeProfiles(doc)` / `clearProfiles()` (jobs pattern).
- `readDefaultProfile(env)`: mirrors `readDefaultTarget`'s `{value,source}|null`
  no-fallback contract. **Precedence (critic fix):** `readDefaultTarget` puts env
  **above** file (`state.mjs:127-128`). `readDefaultProfile` must match —
  `AGENT_COMPANION_DEFAULT_PROFILE` (env) > `profiles.json` `defaultProfile` (file).
- `isModelAllowedFor(companionId, model)`: copilot → `ALLOWED_MODELS.has`;
  opencode → provider/model shape `/^[^/]+\/.+$/`; `modelSelection:false` →
  `model` must be null; unknown companion → false. (Post-cleanup: the old
  copilot-only `isModelAllowed` was folded into `isModelAllowedFor('copilot', model)`.)
- **Thread/sid namespacing (critic fix).** `threadPath(name, profileId?)` /
  `readThreadSid(name, profileId?)` / `writeThreadSid(name, profileId?, sid)` /
  `clearThread(name, profileId?)` gain an optional `profileId` qualifier → on-disk
  slug `<name>__<profileId>.sid` when `profileId` is non-null, legacy `<name>.sid`
  when absent (the synthesized `__default__` profile + all existing single-profile
  installs use the legacy path → byte-identical filenames, zero migration).
  `threadSidCache` key includes `profileId`. `resolveSendThread` is unchanged (the
  human-facing thread NAME stays profile-agnostic for status/UX); only the sid
  lookup disambiguates.
- `default-target` / `default-model` / `threads` / `jobs` files **unchanged**.

### Single-producer enforcement (critic fix — was documentation-only)

The "only `loadProfiles` reads `profiles.json`" rule needs a real guard: the
daemon already demonstrates the failure mode for a sibling file —
`scripts/copilot-acp-daemon.mjs` reads model state at **four** sites (`106, 114,
881, 1374`). Ship a **P1 deliverable** guard test that greps the repo for
`PROFILES_FILE` / `readProfilesRaw` references outside `lib/state.mjs` and
`lib/profile-registry.mjs` and **fails** on any other reference. Document the rule
in the module header. (Optionally an `eslint no-restricted-imports` rule — settle
in P1.)

### Onboarding / doctor

`lib/target-diagnostics.mjs` — add, mirroring `inspectTargets` looping
`listTargetIds`:
- `inspectProfile(profileId, {run, env})`: reuse `inspectTarget(profile.companion)`
  for install/auth/permission (**tri-state `authenticated` preserved — never
  false-green**), then layer profile gates: (a) companion `modelSelection`
  capability present when `profile.model` set; (b) model validity via
  `isModelAllowedFor` — opencode reuses the existing `opencode models` auth-probe
  output (already lists provider/model pairs) to verify the pair cheaply; copilot
  model-validity stays honest `'unknown'`; (c) adapter coherence (an opencode
  `adapter:'server'` profile with the server adapter unavailable → blocker, matches
  STEP C); (d) `STRENGTH_CAPABILITY_REQUIREMENTS` check (no-op under v1 but wired so
  a future requirement surfaces identically in doctor and send).
  `profileReady = companion.ready && model-valid!==false && adapter-coherent && strength-caps-satisfied`.
  The synthesized legacy profile is **not** inspected/listed.
- `inspectProfiles({run, env})`; `profileReadinessSummary()` / `strengthsSummary()`
  mirroring `targetReadinessSummary`.

`lib/doctor.mjs` (`62-136`): `buildDoctorReport` gains `report.profiles =
inspectProfiles()` and `report.strengths` (map strength → `{profileId|null, ready,
ambiguous}`). Extend the `targetOk` roll-up: each strength claimed by any profile
must map to exactly one ready profile — 0 ready → blocker, >1 with no
`defaultProfile` tiebreak → blocker; also surface the inert-tiebreak edge as an
advisory. `report.ok = commonOk && targetOk && strengthsOk`, where `strengthsOk`
**only gates** when `profiles.json` physically exists with ≥1 valid profile (absent
or all-dropped → `strengthsOk=true`) so legacy/all-invalid installs cannot newly
fail. **Do not touch** `report.targets.<id>.ready` keys or the `'not persisted'` /
`'No target is ready'` warning strings (`doctor.test.mjs` depends on them);
profiles/strengths are additive. `renderDoctorReport` adds `profiles:` and
`strengths:` sections in the same render pass.

`scripts/onboard.mjs` (`78-121`): `planOnboard` stays pure/IO-free; add pure
sibling planners `planProfile` (validate companion ∈ `TARGET_IDS`, model via
`isModelAllowedFor`, dedupe id, reject opencode `profile.model` until the
plumbing-verified gate is enabled) and `planStrengthAssignment` (deterministic
conflict mirror: a strength already claimed → ambiguous unless a `defaultProfile`
tiebreak that **actually claims** that strength). New flags `--list-profiles` /
`--define-profile <id> --companion <c> --model <m> --strength <s,...>` /
`--assign-strength` / `--set-default-profile`, plus a `printProfileReport` path.
Persist via `writeProfiles` (atomic `0600`, **ids/model-names/strength-labels
only — never secrets**; auth delegated to vendor tools).

### Harness exposure — one channel, two views

The `agent_status` global response (`handleStatus`, `server.mjs:2182-2228`),
relayed by the subagent. No new tool, no `tools:` allow-list growth, no isolation
breach.

- **(A) Always-on, id-free, harness-facing — `response.strengths`:** a flat array
  of `{name, ready, reason}` where `name` is a strength label and `reason` is null
  or a human string (`'no ready profile declares this strength'`). **No
  companion/model/profile ids.** Bounded by the closed 4-element `VALID_STRENGTHS`,
  so the always-on payload is a handful of lines. This is what the subagent
  enumerates **before** sending.
- **(B) Diagnostics-gated, operator-facing — `response.profiles`:**
  `[{id, companion, model, strengths[], ready, blockers[]}]`, attached only when
  `diagnostics:true` (alongside the existing `buildDoctorReport` at `:2227`).
  Verified: the global status branch consults `diagnostics` (`:2227`) but never
  `verbose` (`verbose` is job-branch-only at `:2188/2196`), so gating here reuses
  the existing seam with zero new wiring.

`running_jobs` entries (`:2212-2225`) gain `profile`/`strength`. The MCP
instructions string (`:2243`) gains one clause about routing by strength/profile
and discovering strengths via `{action:status}`. `defaultProfile` is added beside
`default_target` in the always-on block.

> **Leak test (critic fix — broadened).** The negative-assertion test must scan
> the **whole** flat strengths payload (every field, including `reason`) for
> companion/model/profile-id substrings — not just the `name` field.

## Backward Compat & Migration

**Zero-migration; the feature is inert until `profiles.json` exists with valid
content.**

**Synthesis.** `profiles.json` absent or corrupt (`readProfilesRaw → null`) →
`loadProfiles` synthesizes one degenerate profile
`{id:'__default__', companion: readDefaultTarget().target, model: copilot ? readDefaultModel().model : envOpenCodeModel||null, strengths:[], synthesized:true}`,
with `defaultProfile` set to it. An install with only `default-target` routes
**byte-identically**: same jobId prefix, same copilot-only model semantics, same
legacy unqualified `<thread>.sid` filename, same `TARGET_UNCONFIGURED` when
`default-target` is unset. Synthesis feeds the resolve path **only** — the
synthetic profile is suppressed (`synthesized:true`) from public `profiles[]` and
`inspectProfiles`.

**Precedence ladder (corrected to env-above-file, matching `state.mjs:127-128`):**
explicit send arg (`profile|strength|target`) > `AGENT_COMPANION_DEFAULT_PROFILE`
(env) > `profiles.json` `defaultProfile` (file) > *(profiles.json absent/empty)*
bare-target against [`AGENT_COMPANION_DEFAULT_TARGET` (env) > `default-target`
(file)] > *(profiles.json absent)* synthesized-from-default-target > unset →
`TARGET_UNCONFIGURED`. When both default-profile and default-target resolve with no
explicit arg, default-profile wins.

**Preserved:** `default-target`/`default-model` not removed; `ALLOWED_MODELS`
unchanged (the copilot-only `isModelAllowed` later folded into `isModelAllowedFor`);
status/doctor/onboard only **gain** keys/sections;
`report.targets.<id>.ready`, `default_target`, `targets`, the `'not persisted'`
warnings, and existing `<thread>.sid` filenames are byte-identical; callers passing
no new field see no schema change.

## Implementation Phases

### P1 — Schema-less registry + state primitives + single-producer guard
- **Scope:** `lib/profile-registry.mjs` (`loadProfiles` single-producer +
  synthesis-from-defaults; `listProfiles`/`getProfile`/`resolveStrength`/
  `resolveProfileCapabilities`/`listProfilesPublic`/`flatStrengths`;
  `VALID_STRENGTHS` + `STRENGTH_CAPABILITY_REQUIREMENTS` exports; per-profile
  validation with drop-with-`loadError`; the all-dropped→empty and no-defaultProfile
  states). `lib/state.mjs` (`PROFILES_FILE`, `readProfilesRaw`/`writeProfiles`/
  `clearProfiles`, `readDefaultProfile` env-above-file, `isModelAllowedFor`, the
  `threadPath`/`readThreadSid`/`writeThreadSid`/`clearThread` `profileId`
  qualifier). Single-producer guard test. **No server wiring, no `schemaVersion`.**
- **Files:** `lib/profile-registry.mjs` (new), `lib/state.mjs`,
  `test/profile-registry-guard.test.mjs` (new).
- **Tests:** state round-trip, corrupt→null (no throw), zero leftover `.tmp`,
  host-routed, `readDefaultProfile` unset→null + env-over-file, `isModelAllowedFor`
  per companion, sid namespacing (`<name>__<pid>.sid` vs legacy `<name>.sid`, cache
  keyed by pid); synthesis when absent (`synthesized:true`), all-dropped→empty (no
  synthesis), no-defaultProfile state, profile inherits-never-overrides caps,
  opencode `adapter:'server'` overlay flips reply/resume, `resolveStrength`
  cardinality 0/1/N + non-claimant-defaultProfile→ambiguous, empty-map no-op; guard
  fails on a planted extra reader.
- **Acceptance:** all pure functions deterministic/side-effect-free; corrupt→
  synthesis and all-dropped→empty are distinct; legacy sid filename byte-identical;
  guard green; **no behavior change to the running bridge.**

### P2 — `resolveRouting` chokepoint + capability gate + send wiring + model plumbing
- **Scope:** `server.mjs` `resolveTargetId`→`resolveRouting` as sole SEND brain;
  constraint-consistency precedence; the six new codes; STEP C statically-knowable
  gate; empty/no-default bare-target fallback; model block `@1861` reads
  `resolved.model`; job object + worker dispatch carry
  `profileId/model/strength/companion`; sid lookup `@1856` passes `profileId`;
  reattach guard adds `existing.profileId` → `status:'profile_mismatch'`. **OpenCode
  model plumbing** through both worker paths. `validation.mjs` (`VALID_STRENGTHS`
  import, `ALLOWED_FIELDS.send += profile/strength`, mutual-exclusion check, return
  fields). inputSchema open-string `profile`/`strength` siblings.
- **Files:** `bridge-server/server.mjs`, `bridge-server/validation.mjs`.
- **Tests:** validation (profile/strength accepted, profile+strength rejected,
  unknown strength rejected, return nulls, MCP boundary still rejects unknown keys);
  **table-driven router unit tests** over every `{target,profile,strength}` combo →
  exact code or resolved profile (run in a sandboxed dispatch mirroring the
  release-smoke harness); strength+matching-target OK / +mismatched-target
  `ROUTING_CONFLICT`; non-claimant-defaultProfile→`STRENGTH_AMBIGUOUS`;
  `CAPABILITY_UNAVAILABLE` on `modelSelection:false`+model and `adapter:'server'`
  unavailable; empty/no-default bare-target fallback; `profile_mismatch` reattach
  status shape; **golden byte-identical-job** (copilot+opencode); **copilot
  daemon-model** + **opencode model** regressions (resolved.model in spawn args,
  both adapters); **sid-namespace** + **concurrency** regressions; acceptance assert
  no send-path `normalizeTargetId`/`getTarget` bypasses `resolveRouting`.
- **Acceptance:** bare-target byte-identical to pre-#2; every error echoes
  candidates; one resolver is the sole SEND brain; per-profile model actually
  reaches both copilot and opencode spawn args; sequential/concurrent profile
  switches get isolated sids.

### P3 — Diagnostics + doctor readiness roll-up
- **Scope:** `lib/target-diagnostics.mjs` (`inspectProfile`/`inspectProfiles`,
  `profileReadinessSummary`/`strengthsSummary`; tri-state auth preserved; opencode
  model via `opencode models` probe; copilot `'unknown'`;
  `STRENGTH_CAPABILITY_REQUIREMENTS` check; adapter coherence). `lib/doctor.mjs`
  (`report.profiles`/`report.strengths`, `strengthsOk` roll-up gated on
  profiles.json existing-with-valid-profiles, no-defaultProfile + non-claimant
  advisories, additive render sections).
- **Files:** `lib/target-diagnostics.mjs`, `lib/doctor.mjs`.
- **Tests:** existing `report.targets.<id>.ready` + `'not persisted'`/`'No target
  is ready'` assertions still pass; new strength-with-0-ready→blocker,
  strength-by-2-no-tiebreak→blocker, non-claimant-defaultProfile→inert advisory,
  no-defaultProfile+default-target→advisory, synthesized-install `report.ok`,
  all-dropped `report.ok`, synthetic profile NOT in `report.profiles`.
- **Acceptance:** doctor surfaces gaps/conflicts as blockers like default-target;
  legacy + all-invalid installs unaffected; no existing key/string broken;
  capability-requirement gate agrees with STEP C.

### P4 — Harness exposure (status + templates)
- **Scope:** `server.mjs` `handleStatus` (always-on flat `strengths[]` `{name,
  ready, reason}` no ids + diagnostics-gated `profiles[]` + `defaultProfile` +
  `running_jobs` profile/strength + instructions clause). Templates `.md`/`.toml`
  (document strength/profile wire key + discover-via-status sentence,
  byte-identical; `tools:` unchanged).
- **Files:** `bridge-server/server.mjs`, `templates/agent-companion.md`,
  `templates/agent-companion.toml`.
- **Tests:** status handler (flat `strengths[]` present, **whole-payload** incl.
  `reason` asserts no companion/model/profile-id substrings; `profiles[]` only under
  `diagnostics:true`, not `verbose`); template drift-lock tests (new key documented
  in lockstep, bodies byte-identical, `tools:` unchanged).
- **Acceptance:** subagent enumerates strengths in one status call with zero id
  leakage anywhere in the payload; harness isolation + tools allow-list intact.

### P5 — Onboarding authoring + docs
- **Scope:** `onboard.mjs` (`planProfile`/`planStrengthAssignment` pure, opencode
  model gated on the plumbing-verified flag, tiebreak must claim the strength;
  `--list-profiles`/`--define-profile`/`--assign-strength`/`--set-default-profile`;
  `writeProfiles` persistence; `printProfileReport`). `docs/ARCHITECTURE.md` /
  `docs/MVP_TRACKER.md` (mark backlog #2 done; fold the illustrative shape into the
  real shape).
- **Files:** `scripts/onboard.mjs`, `docs/ARCHITECTURE.md`, `docs/MVP_TRACKER.md`.
- **Tests:** `planProfile` validation + `planStrengthAssignment` deterministic
  conflict (auto/exactly-one/ambiguous-or-none → ask vs `--yes` error), non-claimant
  tiebreak rejected, generated `profiles.json` validates against `loadProfiles`, no
  secrets persisted.
- **Acceptance:** a user can author and validate profiles + strengths
  deterministically; onboarding persists ids/models/labels only; auth delegated to
  vendor tools.

## Committed Regressions (strongest migration guards)

1. **Golden byte-identical-job:** a synthesized-registry bare send produces the
   exact same job object (companion/model/thread/jobId-prefix) **and** the same
   legacy `<thread>.sid` filename as the pre-#2 path, for both copilot and opencode.
2. **Copilot daemon-model:** the bridge spawn path forwards `resolved.profile.model`
   into `runWorker`/daemon spawn args rather than the daemon re-reading
   `default-model` — a non-default copilot profile reaches the daemon with its own
   model.
3. **OpenCode model:** a non-env opencode profile model reaches
   `startOpenCodeRun({model})` (cli) and `startOpenCodeServerPrompt({model})`
   (server) spawn args — closes the validated-then-ignored gap.
4. **Sid-namespace:** same thread name + two distinct profiles → two distinct
   `<name>__<profileId>.sid` files, no cross-read; the `__default__`/legacy path
   still writes `<name>.sid`.
5. **Concurrency:** back-to-back sends (same companion, different model) on auto
   threads get distinct thread names/sids and no `sessionCollectors` overwrite.

## Invariants to Preserve

- **No silent fallback** (cardinal rule): unresolvable/ambiguous target/profile/
  strength → explicit `ok:false` echoing candidates. Identical inputs + identical
  `profiles.json` → identical profile or identical code.
- **MCP boundary closed at both layers:** `additionalProperties:false`
  (`server.mjs:2334`) **and** `assertKnownFields` (`validation.mjs:289-296`). A new
  field must be added to both.
- **Harness isolation:** only the 5 `agent_*` tools and declared fields are
  visible; strengths reach harnesses only via the subagent-relayed `agent_status`
  output and template docs, **without** companion/model ids.
- **`agent-*` naming identity** unchanged on the public surface; the Copilot
  adapter's internal `copilot-*` names are exempt but must not surface as harness
  vocabulary.
- **Capability-driven, no universal assumptions:** profiles inherit, never
  override, their companion's real capabilities; a strength label never implies
  capabilities the backing profile lacks.
- **Host-routed state** under `BASE_DIR`; same atomic-write + `readFileSafe`/
  `readJob` (null on missing/corrupt, never throw) discipline.
- **Validators stay pure/side-effect-light:** structural value checks in
  `validation.mjs`; existence/conflict/registry resolution defers to the server
  resolve step.
- **Job identity continuity:** `job.target = companion` keeps the
  `job.target||'copilot'` downstream reads working; new fields persist
  automatically via `writeJob`.
- **Per-target model gating stays companion-specific:** `ALLOWED_MODELS` guards
  Copilot only; OpenCode and Codex use different rules.
- **One-detached-server reuse:** profiles selecting different models on the same
  companion reuse the same detached server.
- **No secrets stored or prompted.**

## Remaining Open Questions (non-blocking; revisit during build)

- **Shared-name thread ownership in status/UX:** the sid is now namespaced by
  profile, but the human-facing thread NAME stays shared. Whether status/inspect
  should also show *which* profile currently owns a shared-name thread is a minor
  UX item; revisit if operators find it confusing.
- **Strength ↔ fleet interaction:** `parallel`/`fleet` is Copilot-only and
  auto-selected. v1 keeps it orthogonal (strength does not touch fleet); if a
  "parallel reviewer" is ever wanted, express it via
  `STRENGTH_CAPABILITY_REQUIREMENTS` (requiring `parallel`) so STEP C and doctor
  enforce it uniformly.
- **`startOpenCodeServerPrompt` model override:** confirm it accepts a per-call
  model that supersedes `resolveOpenCodeServerModel`'s env default cleanly without
  breaking the env fallback for the synthesized/default path
  (`opencode-server-runtime.mjs:56`).
- **Synthesized-profile visibility:** suppressed from `profiles[]`/`inspectProfiles`
  to minimize churn; consider surfacing it **only** under `diagnostics:true` with a
  `synthesized:true` marker if operator confusion arises.
- **Single-producer guard mechanism:** a node test scanning source is the v1 plan;
  whether to also add an `eslint no-restricted-imports` rule (stronger, but adds an
  eslint config surface the repo may not have) is an implementation choice for P1.

## Validation Commands

```bash
node --check lib/profile-registry.mjs
node --check lib/state.mjs
node --check bridge-server/server.mjs
node --check bridge-server/validation.mjs
node --check lib/target-diagnostics.mjs
node --check lib/doctor.mjs
node --check scripts/onboard.mjs
node --test $(find bridge-server lib scripts hooks templates test -name '*.test.mjs')
node scripts/validate-codex-release.mjs
claude plugin validate .
```
