# User defaults for companion model and effort: plan

Status: decisions agreed and step 0 measured (2026-11-18); steps 1 to 8 not started.

## Goal

The person, not only the host AI, sets the model and effort each companion uses
by default. The setting lives in one place shared by both hosts. The person can
also see what an "inherit" resolves to before a job runs.

## Decisions (2026-11-18)

1. **The saved default applies when the host names none; the host's explicit
   choice wins.** This holds for model and effort alike. Example: with a saved
   effort of `medium`, a host request for `xhigh` runs `xhigh`. With a saved
   `xhigh`, a request with no effort runs `xhigh`. There is no lock and no cost
   cap.
2. **In scope:** a saved model default, a saved effort default, showing what
   inherit resolves to, and selecting Copilot's model through the session
   instead of a fixed list.
3. **Surfaces:** the CLI `agent-companion defaults` and a live-view defaults
   panel. Both call one implementation. A Codex skill and `/companion`
   subcommands go to the backlog (Next Backlog in `docs/MVP_TRACKER.md`).
   Claude's `/companion` keeps opening the Companions pane.
4. **One shared settings file for both hosts.**
5. **Defaults are applied in one place, routing, for all five companions.** This
   includes removing Antigravity's own read, which the user approved despite the
   pause. It gets unit and replay tests only, no live run.

## Evidence (measured 2026-11-18)

All measurements ran in throwaway homes under `/tmp` and cost no tokens, except
job `be3f3720`.

**Codex 0.170.0**
- The bridge is ready for `gpt-6.2-astra`. A Claude-host job with no model
  reported `effective_model: gpt-6.2-astra`, and requested `low` was validated and
  reported back (job `be3f3720`). The app-server schema matches the pinned 0.169.0
  contract.
- The catalog lists `gpt-6.2-astra` with levels `low`, `medium`, `high`, `xhigh`,
  `max`, `ultra` and default `low`. Every `gpt-6*` model offers `low` to `max`;
  all but `gpt-6-luna` also offer `ultra`.
- `config/read` (no thread) returns the resolved `model` and
  `model_reasoning_effort`. With `cwd`, a **trusted** project's
  `.codex/config.toml` overrides the global value (`gpt-6-sol` beat
  `gpt-6.2-astra`); an untrusted project's file is ignored. With nothing set,
  both are `null` and `model/list`'s `isDefault` applies (`gpt-6.2-sol`, effort
  `low`). A legacy top-level `profile =` key makes `config/read` fail ("no longer
  supported").
- `thread/resume` with no model keeps the thread's own model and effort, not the
  config's. Config said `gpt-6-astra medium`; the resumed thread reported
  `gpt-6.2-astra low`. So a Codex conversation keeps what it started with no
  matter what we do, and follow-ups to subagents started before today stay on
  `gpt-6-astra`.
- Codex has no plugin slash commands. A plugin's `commands/*.md` was not exposed
  on install, whether the plugin had a `.codex-plugin` manifest, a
  `.claude-plugin` one, or both. Only `skills/<name>/SKILL.md` appears, as
  `<plugin>:<name>` (`skills/list`). The person invokes a skill with a `$` mention
  or `/skills`, and the model carries it out in a turn. `.codex-plugin/plugin.json`
  `"skills": "./codex-skills/"` points Codex at a Codex-only directory.
- Under `workspace-write`, `codex sandbox` refused writes to any `$HOME` path
  outside the workspace, including a `CODEX_HOME` under `$HOME`. Reads anywhere
  succeeded. A model-run skill therefore cannot save the settings file without
  escalation.

**Copilot CLI 1.0.113** (BYOK against a stub `/models` server, no prompt sent)
- `--model bogus-model` is accepted silently. The session advertises
  `model: current=bogus-model options=[auto,bogus-model]`, so the spawn flag
  cannot validate.
- `session/set_config_option` `configId: model` refuses any model not in the
  session's options: `-32602 "Invalid modelId '…': not one of this session's
  models."`.
- In BYOK mode, the session's options are `auto` plus the configured model, and
  Copilot does not query `/models`. With no model at all it exits: "BYOK
  providers require an explicit model".
- GitHub-hosted models stay unmeasured (this account gets a 403 on
  `session/new`). `~/.copilot/settings.json` has no `model`.

**Claude Code 2.1.327**
- `~/.claude/settings.json` has no `model`, so the account default applies. Effort
  comes from `effortLevel: xhigh` plus per-model `modelSettings.<id>.effortLevel`.
  Claude Code resolves these layers itself. The companion reports its model at
  init only after the first user line, so there is no zero-token read.

**OpenCode 2.3.0**
- `~/.config/opencode/opencode.jsonc` sets no model. The inherited model comes
  from a running server's `/model/default?directory=`, which the adapter already
  calls (`opencode.mjs:133`). Starting the server costs no tokens.

**This repo**
- Defaults are applied in four places. Routing applies them to new conversations
  only (`server.mjs:351`, `:185`). The Copilot descriptor
  (`target-registry.mjs:235`) and the Antigravity descriptor (`:449`) apply the
  saved model on every start, follow-ups included. The OpenCode adapter re-reads
  `AGENT_COMPANION_OPENCODE_MODEL` (`opencode.mjs:125`).
- `ALLOWED_MODELS` (`state.mjs:33`) gates both saved and requested Copilot
  models.
- The ACP adapter already has a validated `acp.setModel` path (`acp.mjs:73`,
  used by Antigravity). A number error or a `currentValue` mismatch becomes
  `MODEL_NOT_ALLOWED`.
- The two host state dirs hold `default-target = codex` each and no
  `default-model*` files.
- `launch-ui.sh` already dispatches `follow`, `jobs` and `send`. The live view
  has free keys (`d` and `s` are unused, `model.mjs:193-268`).

## Design

**Store.** `lib/state.mjs` owns one `settings.json`:
`{ target, companions: { <id>: { model, effort } } }`. The path is
`$AGENT_COMPANION_HOME/settings.json` when that is set (tests and probes),
otherwise `${XDG_CONFIG_HOME:-~/.config}/agent-companion/settings.json`. Every
host, the CLI and the view can read it, including from inside Codex's sandbox.

**Migration.** A one-shot migration reads both hosts' `default-target` and
`default-model*` files. Identical values move over. Conflicting values are not
migrated, and `defaults` lists both for the person to choose; nothing is picked
silently. The old files are then removed. A bridge still running old code
loses its default target until the session restarts.

**Precedence for a new conversation.** For model: the host's request, then the
model env knob (unchanged), then the saved default, then native configuration.
For effort: the host's request, then the saved default, then native
configuration. Routing records the result on the conversation, as model
defaults are recorded today. A follow-up therefore keeps what its conversation
started with, which Codex also enforces natively. If a saved effort is invalid
for the model that runs, the existing validation refuses it, and the message
names the saved default.

**Resolution shown for inherit.**
- Codex: `config/read` (global, or for a `cwd`), falling back to `model/list`'s
  default.
- OpenCode: `/model/default` from a short-lived server.
- Claude, Copilot and Antigravity: the last run's reported values from both
  hosts' execution records, with their age. Claude's effort is shown as "not
  reported".
- The CLI and the panel do the native reads. The catalog shows saved values and
  the last run only, so it never spawns a process.

**Validation when saving.** Codex checks the model and its levels against
`model/list`. A model missing from the list (custom providers) is saved and
marked unverified. OpenCode checks models and variants on a short-lived server.
Claude gets a structural model check plus its static levels. Copilot and
Antigravity are saved unverified, because only a session can tell. Every send
validates again.

## Steps

The work happens in a worktree off main. Record the full suite before step 1
and keep it green after each step. One commit per step, each with its own check.

### Step 1: Copilot model through the session option

Copilot gets an `acp.setModel` (`session/set_config_option`, `configId: model`).
`--model` leaves its spawn args, and `defaultModel` and `ALLOWED_MODELS` go. A
refusal returns `MODEL_NOT_ALLOWED` listing the session's advertised values. The
catalog drops `allowed`.

Check: ACP unit tests, a re-record of Copilot fixtures with
`probes/acp-record/record-copilot.mjs` (local Ollama, started only for the run),
and a stub-backend test showing a bogus model refused.

### Step 2: Shared store and one application point

The store and migration described above. `readDefaultModel` and
`readDefaultTarget` read from the store. Remove the OpenCode adapter's env read
and Antigravity's `defaultModel`, so routing is the only place defaults apply.
`onboard.mjs --set-default` and `setup.sh --target/--model` write the store.

Check: unit tests under `test/sandbox-home.mjs` for the store, migration
(identical, conflicting, absent) and precedence, `refuseRealHomeUnderTest`
covering the new path, Antigravity replay tests, and the full suite.

### Step 3: Effort default

Routing applies the saved effort to a new conversation when the host gives
none. An invalid saved effort is refused by the existing per-companion
validation, with a message naming its source.

Check: routing and conversation tests, then a live run with an isolated
`AGENT_COMPANION_HOME`: Codex with saved `low`, one send with no effort and one
with `medium`, confirmed from `effective_effort` and the rollout's `turn_context`.
OpenCode gets the same run on a free model.

### Step 4: CLI `agent-companion defaults`

`launch-ui.sh defaults` runs one module that parses, validates, reads native
values and prints. It reuses the adapters' protocol helpers rather than adding a
second JSON-RPC client.

```text
agent-companion defaults                        # every companion: saved, source, resolved
agent-companion defaults codex                  # one companion
agent-companion defaults codex model=gpt-6.2-astra effort=high
agent-companion defaults codex model=inherit    # clear one value
agent-companion defaults target=codex           # default companion
```

Check: CLI unit tests with fake app-server and OpenCode responses. A live
read-only `agent-companion defaults` on this machine must show Codex inherit as
`gpt-6.2-astra xhigh`. Live set and clear run with an isolated
`AGENT_COMPANION_HOME`.

### Step 5: Catalog

The per-companion `model` and `effort` gain `saved` and `last_run` (value and
age). The description says what inherit means for each companion.

Check: catalog tests, and a live catalog read through the subagent.

### Step 6: Live-view defaults panel

`d` opens a panel listing each companion's saved and resolved values. Edits use
a text field like the message box and save through step 4's functions, making
`lib/state.mjs` the views' second write path besides `inbox.mjs`. It works on
both hosts, because the view runs in the person's terminal.

Check: UI model tests and snapshots, and a live edit in an isolated home read
back by `agent-companion defaults`.

### Step 7: Docs and backlog

Update README Configuration, ARCHITECTURE (state, precedence, and removal of the
per-host default files), MVP_TRACKER (drop the effort-default limitation), and
the CLAUDE.md module table (store owner, the views' write paths, the `defaults`
entry).

Check: a coherence pass, grepping for `ALLOWED_MODELS`, `default-model-`,
`defaultModel:` and "no saved effort default".

### Step 8: Codex contract provenance

Run `node scripts/gen-codex-app-server-contract.mjs` for 0.170.0. The schema
already matches.

Check: the drift test reports `match` with no skew note.

## After merge

Run `setup.sh --host both --target none --skip-tests --yes` and restart sessions.
The first bridge to start migrates `default-target = codex` from both hosts.
Then run `agent-companion defaults` on this machine.

## Risks

- Copilot's GitHub-hosted path stays unqualified. BYOK measured that the session
  option validates and the flag does not.
- The migration removes per-host files that an old bridge still reads. Restart
  sessions after upgrading.
- A trusted project's Codex config can make inherit differ per repo. `defaults`
  shows the global value unless given a `cwd`.
