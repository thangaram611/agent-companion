# Release Readiness

Last updated: 2026-06-23

This page is the public-readiness checklist for the harness + companion launch.
It records the source-backed compatibility assumptions behind the repo copy,
setup flow, and next backlog.

## Public Positioning

Slogan:

> Come with any harness and attach any companion of your choice to it.

Current vocabulary:

| Product term | Current implementation term | Supported now |
| --- | --- | --- |
| Harness | `host` | Claude Code, Codex CLI |
| Companion | `target` | OpenCode, GitHub Copilot CLI |
| Companion profile | not implemented yet | planned |
| Strength | not implemented yet | planned |

Current routing is still one-to-one: one `agent_send` resolves to one companion
target runtime. The future direction is one-to-many companion profiles routed by
strengths such as `reviewer`, `web_researcher`, `planner`, or `fast_executor`.

## Source-Backed Compatibility Notes

Claude Code plugins:

- Claude Code documents plugins as self-contained component bundles that can
  include agents, hooks, MCP servers, skills, and other components:
  <https://code.claude.com/docs/en/plugins-reference>.
- Claude plugin-shipped agents do not support `hooks`, `mcpServers`, or
  `permissionMode` frontmatter. This repo keeps the marketplace/plugin package
  and materialized standalone agent path separate for that reason.

Codex plugins:

- Codex requires `.codex-plugin/plugin.json` and documents `interface` metadata
  for install-surface copy:
  <https://developers.openai.com/codex/plugins/build>.
- Codex plugins can bundle lifecycle hooks through the manifest or the default
  `hooks/hooks.json` path, and plugin-bundled hooks still go through trust
  review:
  <https://developers.openai.com/codex/hooks>.

OpenCode companion:

- The current adapter uses the documented non-interactive `opencode run` path.
  OpenCode documents `--format`, `--model`, `--attach`, and `--dir` flags for
  `run`: <https://opencode.ai/docs/cli/>.
- `opencode models` lists configured provider models in `provider/model` form,
  which is the right basis for future OpenCode companion profiles:
  <https://opencode.ai/docs/cli/>.
- OpenCode documents `opencode acp` for ACP-compatible editors and IDEs:
  <https://opencode.ai/docs/acp/>. That makes an OpenCode ACP adapter the
  strongest next implementation path for reply/resume parity.
- OpenCode permissions are configured as `allow`, `ask`, or `deny`; unattended
  runs need explicit permission design rather than hidden auto-approval:
  <https://opencode.ai/docs/permissions/>.

GitHub Copilot CLI companion:

- GitHub documents Copilot CLI authentication through `/login`, workspace trust
  prompts, and tool approval prompts:
  <https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/overview>.
- Copilot CLI model selection is documented through `--model=MODEL` or
  `COPILOT_MODEL`. The cited CLI reference enumerates the full supported-model
  table — `claude-sonnet-4.6` (default), `claude-haiku-4.5`, `gpt-5.4`,
  `gpt-5.3-codex`, `gemini-3.1-pro-preview`, `gemini-3.5-flash`,
  `mai-code-1-flash`, and `auto` — which is the basis for the `ALLOWED_MODELS`
  set in `lib/state.mjs`:
  <https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference>.
  Public docs and defaults should not advertise an undocumented Copilot model id.

## Release Gates

Automated gates:

```bash
bash -n setup.sh hooks/*.sh
find bridge-server lib scripts hooks templates -path '*/node_modules' -prune -o -type f -name '*.mjs' -print0 | xargs -0 -n1 node --check
node --test --experimental-test-coverage $(find bridge-server lib scripts hooks templates -path '*/node_modules' -prune -o -type f -name '*.test.mjs' -print)
node scripts/validate-codex-release.mjs
claude plugin validate .
```

Manual smoke gates before a public tag:

1. Claude Code source checkout install with `bash setup.sh --host claude --target none`.
2. Codex CLI source checkout install with `bash setup.sh --host codex --target none`.
3. OpenCode default-target onboarding and one real delegated send.
4. Copilot default-target onboarding and one real delegated send.
5. Codex marketplace build/install using `node scripts/validate-codex-release.mjs`.
6. Claude marketplace install or `claude --plugin-dir` smoke.

Do not claim strength routing, companion profiles, multiple models per
companion, OpenCode reply/re-steer, or OpenCode restart resume as implemented
until those paths have code and tests.
