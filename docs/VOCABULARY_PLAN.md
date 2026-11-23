# One vocabulary: companion, thread, job: plan

Status: planned 2026-11-23, on `feat/vocabulary`. Ships as 1.0.0 again: the
v1.0.0 tag moves to the result and its release notes are rewritten (decided by
the user: nobody has installed the first 1.0.0).

## Goal

The lead model, the user and the code use one name for each thing. Today one
idea goes by several names: the companion is `target` in the tools, the
settings and the setup flags; a thread is a `conversation` whose id sits in a
field named `owner`; a job is an `execution`; and the tools are `agent_*`,
while both hosts already have native agent tools (Claude's `Agent`, Codex's
`spawn_agent`) a lead can confuse them with.

## Glossary

| Word | Means | Id |
| --- | --- | --- |
| **Host** | The app the user talks to: Claude Code or Codex CLI. | — |
| **Lead** | The user's conversation in a host, the one calling the tools. | the host's session id |
| **Companion** | The coding agent that does the work: OpenCode, GitHub Copilot CLI, Codex CLI, Google Antigravity or Claude Code. | `opencode`, `copilot`, `codex`, `antigravity`, `claude` |
| **Default companion** | The companion `companion_send` uses when the lead names none (setup or `agent-companion defaults` saves it). | — |
| **Thread** | One ongoing conversation with one companion in one directory, owned by one lead. A lead can run many threads at once, on different companions. | `th-` + 10 hex |
| **Job** | One run of the companion on a thread: from a send that starts work to its result. A thread holds a sequence of jobs. | `job_id` |

"Agent" is not used on its own anywhere. The plugin keeps its name
(`agent-companion`) and the MCP server keeps `agent-bridge`.

## Decisions (2026-11-23, the user)

1. **Tools are `companion_*`:** `companion_send`, `companion_wait`,
   `companion_read`, `companion_status`, `companion_cancel`,
   `companion_catalog`.
2. **The rename goes all the way down:** tool schemas, responses, refusal
   codes, notices, MCP instructions, docs, both views, setup and onboard flags,
   settings, the registry module and its functions, the record folders and
   fields. Each on-disk change has a one-time migration.
3. **`companion_status` with a `thread` or `job_id` inspects it; with neither
   it lists the caller's threads in one short row each** (thread, title,
   companion, state, latest job, unread). The companions' fixed details
   (14.8 KB, about 3,700 tokens) leave the default response and appear only
   with `diagnostics: true`.
4. **Each job's record carries its companion's display name** from the
   registry, so the mod and the views stop keeping their own list
   (`COMPANION_NAMES` in `ui/rows.mjs`). Antigravity's usage quirk moves from
   `lib/usage.mjs` into its registry entry. A new host stays at about nine
   files: install steps, permissions and lead transcripts differ per host.
5. **Job lifetime is unchanged:** a job lives as long as its lead's bridge.
6. **README images are regenerated** for the thread design (three PNGs through
   Codex's image tool, the demo re-recorded with vhs).

## Names, old to new

Outside the code:

| Old | New |
| --- | --- |
| `agent_send`, `agent_wait`, `agent_read`, `agent_status`, `agent_cancel`, `agent_catalog` | `companion_send`, `companion_wait`, `companion_read`, `companion_status`, `companion_cancel`, `companion_catalog` |
| parameter and field `target` | `companion` |
| `default_target`, `targets` | `default_companion`, `companions` |
| `TARGET_UNCONFIGURED`, `TARGET_UNSUPPORTED` | `COMPANION_UNCONFIGURED`, `COMPANION_UNSUPPORTED` |
| setup and onboard `--target`, `--no-target-check` | `--companion`, `--no-companion-check` |
| `AGENT_COMPANION_DEFAULT_TARGET` | `AGENT_COMPANION_DEFAULT_COMPANION` |
| `settings.json` key `target` | `companion` |
| `target-checks.json` | `companion-checks.json` |

In the code:

| Old | New |
| --- | --- |
| `lib/target-registry.mjs`, `lib/target-diagnostics.mjs` and their tests | `lib/companion-registry.mjs`, `lib/companion-diagnostics.mjs` |
| `TARGETS`, `getTarget`, `listTargets`, `listTargetIds`, `defaultTargetId`, `defaultTargetInfo`, `TARGET_IDS`, `readDefaultTarget` and the rest | `COMPANIONS`, `getCompanion`, `listCompanions`, `listCompanionIds`, `defaultCompanionId`, `defaultCompanionInfo`, `COMPANION_IDS`, `readDefaultCompanion` and the rest |
| record folders `conversations/`, `executions/` | `threads/`, `jobs/` |
| record fields `owner` (the thread id), `executionId`, `provider` (the companion id) | `thread`, `jobId`, `companion` |
| records and controller API: `readConversation`, `listConversations`, `readExecution`, `executionId` arguments | `readThread`, `listThreads`, `readJob`, `jobId` |

A word is renamed only where it names the bridge's own idea. `provider` also
means a model provider (OpenCode's `providerID`, Codex's `model_provider`),
`conversation` a companion's native conversation, and `target` and `owner` have
unrelated uses (DOM events, file owners, build targets); those stay.

Dated historical records (`docs/RELIABILITY_REMEDIATION.md`,
`docs/DIRECTION_ASSESSMENT.md`, the host and companion reports, the earlier
plans) keep their wording and gain one line naming the 1.0.0 vocabulary.

## Migration

One function in `bridge-server/controller/records.mjs`, idempotent, under a
lock in the state directory, run by every reader that opens a store (the
bridge at startup, the views, the recursion guard reading the other host's
records, the hook's delivery path):

1. If `conversations/` exists, any `threads/` or `jobs/` beside it is 0.x
   state (measured on the operator's homes: 110 and 194 files from 5 to 6
   Nov). Move those two folders, and the other 0.x leftovers
   (`attachments/`, `completions/`, `leases/`, `stops/`, `phase1-migrated`,
   `daemon.log`, `profiles.retired-*`), into `legacy/`. Nothing is deleted.
2. Rewrite each record of `conversations/` and `executions/` into `threads/`
   and `jobs/` with the new field names, atomically, then remove the old file.
   Results get the same field renames in place. A record that already exists
   under the new name wins.
3. `settings.json` `target` and `target-checks.json` become `companion` and
   `companion-checks.json` in the same pass as the defaults migration.

A bridge still running old code may write `conversations/` after the
migration; the next reader moves that record over by the same rules.

## Steps

### Step 1: Names outside the code

Everything the lead and the user read: tools, schemas, responses, codes,
notices, instructions, hook matchers, the permission installer (it also
removes the old `agent_*` entries), the mod, setup and onboard, settings with
its migration, the views' labels, docs and probes.

Check: the touched suites; `claude plugin test .`; `bash -n`; no `agent_send`
or `target` left in the tool schemas (one test reads `tools` and asserts the
names).

### Step 2: Names in the code and on disk

The registry and diagnostics modules and their identifiers, the records'
folders, fields and API with the migration, the controller and views.

Check: the touched suites; a migration test from a copy of a 1.0.0 store
holding 0.x folders: legacy moved, records renamed, a second run changes
nothing, a record written to `conversations/` after the run is moved by the
next.

### Step 3: Status, display names, usage

Decisions 3 and 4.

Check: a status test for the slim rows and for `diagnostics: true`; a mod test
that a card shows the record's display name; the usage tests unchanged in
outcome.

### Step 4: README images

Decision 6. `assets/readme/PROMPTS.md` describes the thread design first.

Check: every label read against PROMPTS.md; the demo shows a real wake.

### Step 5: Live, installed and release

The full suite; `probes/direct-lead/live.mjs` smoke, wake and read70 on both
hosts; a copy of each real store migrated and listed by the views before the
installed run; the installed run on both hosts; then the release: version
stays 1.0.0, the tag moves, notes are rewritten and shown first.
