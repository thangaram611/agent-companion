# Copilot CLI host probes

Hand-run on macOS with Copilot CLI 1.0.114. These use synthetic sessions, a local fixture plugin, and the existing `gpt-oss:20b` model. Run from the checkout. See [the measurements](../../docs/COPILOT_HOST_PLAN.md).

1. In a separate terminal, run `python3 probes/copilot-host/private-ollama.py`. It waits for gpt-oss to leave port 11434, starts a private server on 11435 with a clone of the model, and removes its temp tree on exit. Use `--cpu` if Metal cannot create a command queue. Stop with Ctrl-C and check `lsof -nP -iTCP:11435 -sTCP:LISTEN` is empty.
2. Create one fresh directory for each experiment. Only deliberate same-profile session-switch and ACP controls share a directory. Use its launcher for **every Copilot command**. It sets the local BYOK endpoint, private HOME, COPILOT_HOME, XDG and temp paths and changes into the synthetic workspace.

   ```sh
   run=$(python3 probes/copilot-host/prepare.py)
   "$run/run" copilot --version
   "$run/run" copilot plugin install "$run/package"
   "$run/run" copilot config experimental true
   "$run/run" copilot --disable-builtin-mcps --sync-session=off
   ```

3. Accept folder trust for the displayed temp workspace. In another terminal, use the same run path. `events` is newline-delimited JSON. Select the target extension by its `joined` event. For a normal root call, ask the model to “call companion_probe once and report its token.” To confine the model's tools, launch with `--agent host-fixture:fixture-reader`.

   ```sh
   sid=$(jq -r 'select(.event=="joined") | .session' "$run/events" | tail -1)
   test -n "$sid" && printf '%s\n' 'Reply BRAVO-507.' > "$run/send-$sid"
   ```

| Control | How to repeat |
| --- | --- |
| Install | For local marketplace tests, place the generated package under a temp marketplace with a `.github/plugin/marketplace.json` entry pointing to `./package`. Run the lifecycle commands in the plan using the isolated launcher. For the Claude coexistence control use the repo's marketplace file, two same-named manifests with differently named servers, and `copilot mcp list`. |
| Identity, permissions and hooks | Send the prompt above. To request the same tool from the host's native invocation pipeline without another model decision, write `root` to `execute-$sid`. The default prompts. Approve once. Touch `pre-allow`, repeat, remove it, then touch `permission-allow` and repeat. The fixtures match their own tool. Touch `stamp` to exercise hook argument rewriting. For a real subagent call write `subagent` to `execute-$sid`. Compare hook session, agent and call ID with MCP session, PID and call metadata. |
| Busy, idle and multiple-session wake | Set `delay` to 16 (seconds) before the model call. Upon its MCP `call` event, write a notice containing a unique token to that session's `send-$sid`. Compare `sending`, `sent`, `reply` and the native session's `user.message`, tool completion and assistant messages. Use `/new` for another root, address each separately and check both transcripts. |
| Lifetime | Record `start` and `joined` PIDs before and after `/new`, `/resume <first-id>`, `/clear` and `/exit`. Use `lsof -a -p PID -d txt` and each profile's open-session state to distinguish teardown from switching. An abrupt teardown can kill a fixture before it logs EOF. |
| Timeout | Set `delay` to 190 and trigger a model call. Compare the MCP call and cancellation timestamps. The direct SDK control is `touch "$run/call-$sid"`. In a fresh package put `timeout: 2300` on the MCP server **before installing**. With a 6 s delay, repeat the native and direct calls. The late fixture reply is intentional. |
| Model request inspection | With a prepared home, start `"$run/run" node "$PWD/probes/copilot-host/observe.mjs" "$run"` in another terminal. Launch Copilot through `"$run/run" env COPILOT_PROVIDER_BASE_URL="http://127.0.0.1:$(cat "$run/observer-port")/v1" copilot …`. The observer forwards real requests to private Ollama and logs tool names and fixed canary presence only. Compare fresh default and `--allow-all-mcp-server-instructions` launches. Stop the observer with Ctrl-C. |
| Companion recursion | With a plugin installed, run `python3 probes/copilot-host/acp.py "$run"`, then repeat with `--disable-mcp-server agent-bridge`. Compare the returned session IDs to fixture start events. Both commands use the isolated launcher, the production ACP flags and a synthetic job marker. |

Exit every probe CLI before deleting its generated directory. All evidence in these directories is disposable. No scripted model or real user profile is required.
