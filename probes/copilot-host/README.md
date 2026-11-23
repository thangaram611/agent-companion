# Copilot CLI host probes

Hand-run on macOS with Copilot CLI 1.0.114. These use synthetic sessions, a local fixture plugin, and the existing `gpt-oss:20b` model. Run from the checkout. See [the measurements](../../docs/COPILOT_HOST_PLAN.md).

1. In a separate terminal, run `python3 probes/copilot-host/private-ollama.py`. It waits for gpt-oss to leave port 11434, starts a private server on 11435 with a clone of the model, and removes its temp tree on exit. For installed qualification use the GPU outside the sandbox. Stop if Metal is unavailable. Stop with Ctrl-C and check `lsof -nP -iTCP:11435 -sTCP:LISTEN` is empty.
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

## Installed product

Start the private Ollama as above. Run `python3 probes/copilot-host/product.py` and set
`d` to the temporary directory it prints. It copies the current checkout, pins
the companion's BYOK environment on that copy, runs actual setup twice and
checks the CLI's effective marketplace, plugin, MCP and experimental setting.
After the install checks, it adds a separate probe plugin with a control extension, a post-tool hook and a native subagent. The profile also has a synthetic, unrelated MCP. All
Copilot invocations below must use `"$d/run"`. Inspect only this profile.
Before any model turn, load the model with an empty prompt on the private
server and check that its processor is GPU and context length is 32768. Stop
the private server if it reports CPU.

```sh
"$d/run" curl -fsS http://127.0.0.1:11435/api/generate -d '{"model":"gpt-oss:20b","prompt":"","stream":false}'
"$d/run" env OLLAMA_HOST=127.0.0.1:11435 ollama ps
check() { python3 probes/copilot-host/check.py "$d" "$@"; }
```

1. Run `python3 probes/copilot-host/check.py "$d" tools` to check the six tool names and direct-call identity refusals. Start the printed TUI command. Approve folder trust. Use
   `python3 probes/copilot-host/check.py "$d" sessions`, then `/new`, to
   record root IDs A and B. Each has its own bridge and joined extension.
   Use `check call "$A" agent-bridge-companion_status '{}'` for a
   native invocation with hooks and approvals. Check both empty listings.
2. Ask A to send a Copilot job with the absolute disposable workspace as cwd,
   request a unique token, and finish the turn after send. Inspect the job,
   the returned wake, the matching user.message in A's events.jsonl, and
   `"$d/run" bash "$d/checkout/hooks/launch-ui.sh" ui`. B's listing must
   exclude it and B's read by thread must return THREAD_NOT_YOURS. In A,
   read and follow up for the original token. Cancel a separate running job.
3. For a busy wake set `echo 16 > "$d/delay"`. Ask B to use
   `probe-control-companion_probe`, or invoke it with `check call "$B" probe-control-companion_probe '{}'`.
   Approve the fixture tool. After its call appears in `$d/events`, run
   `check wake "$B" "Reply BUSY-481."` while it is outstanding.
   Verify acknowledgement before the fixture reply and the queued user.message
   and next answer only in B. Two overlapping jobs should produce one notice
   each. Race wait against completion and verify that wait or the delivery
   hook returns the answer once. A read remains possible.
4. Ask the TUI to run two `product-control:fixture-reader` task subagents and a nested one, each sending
   a separate Copilot job and waiting. Inspect the three thread records for
   the same root, distinct agent IDs, and send acknowledgements with
   `reason: subagent` and `fallback: companion_wait`. Have siblings exchange
   thread IDs and check ownership refusals. Check the separate post-tool canary PROBE-HOOK-673 alongside the product result. A native invocation with a
   supplied lead must still use the hook identity.
5. Leave a job running in A for at least an hour after switching to B. Use a
   synthetic task that waits for a file in the disposable workspace and
   create that file from a second terminal after the hour. Check the original
   bridge PID stayed alive and only A got the result. On a separate long job
   run wait with max_wait_sec 1200: time the returned still-running response,
   then cancel another wait and check that its job continues. Clear a root
   during work, then exit during work: compare registrations, bridge startups,
   fenced job results and the other root's listing before and after each.
6. Run `python3 probes/copilot-host/check.py "$d" recursion` with the TUI open.
   It checks a real marked ACP session against startup counts and the unrelated
   MCP's positive control. During the model-backed first send and follow-up,
   also check `$d/companion-starts`, marked control starts, and zero additional
   bridges or notice registrations. The shared controller unit test checks all
   five adapters' job markers.
7. Exit Copilot. In the isolated profile set `extensions.mode disabled` using
   `"$d/run" copilot config extensions.mode disabled`, reopen the TUI, and check
   doctor, send's fallback and wait. For lifecycle use `"$d/run" copilot plugin`
   with disable, enable, update and uninstall of `agent-companion@agent-companion`.
   Compare `mcp list` each time. Stop private Ollama and remove the probe
   directory after checking the final receipts and cleanup.

For other reachable companions, qualify send, wait/read, follow-up and cancel
only after explicitly configuring and verifying their local backend in the
disposable checkout. The supplied launcher pins Copilot to private Ollama.
Interactive checks of the other companions need their own isolated configuration.
