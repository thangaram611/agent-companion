---
description: Delegate a task to GitHub Copilot CLI via the copilot-companion subagent
argument-hint: <task to delegate>
allowed-tools: Task
---

# Delegate to Copilot

Spawn the `copilot-companion` subagent in the background with this payload as the `prompt`:

    {"action":"send","task":"$ARGUMENTS"}

Use the Task tool with `subagent_type: "copilot-companion"` and `run_in_background: true`. The companion dispatches to Copilot CLI; the result surfaces via the plugin's drain hook on your next turn — no polling needed.

Report the spawned `agentId` to the user so they can use SendMessage to follow up (`{"action":"reply", ...}`), check status (`{"action":"status"}`), or cancel (`{"action":"cancel"}`) without leaving this conversation.

If `$ARGUMENTS` is empty, ask the user what they want to delegate before spawning — don't dispatch with an empty task.
