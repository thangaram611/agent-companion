# README image specifications

The three PNGs in this directory are generated bitmaps, produced on 2026-11-06
with Codex's `imagegen` skill (built-in `image_gen` tool). There is no vector
source. To regenerate, give an image model the shared style and one
specification below, then check every label against the text here before
committing; CI only checks that the files exist.

## Shared style

Flat vector-style illustration on a solid dark navy background (#0f172a).
Electric teal as the only accent, plus white and soft gray. Clean geometric
shapes, generous whitespace. No photorealism, gradients, gloss, logos,
trademarks, watermark or text beyond the labels specified. Readable sans-serif
labels. Landscape, 16:9 or 2:1.

## hero.png

Concept: "Come with any harness and attach any companion of your choice."
One terminal window on the left labelled `harness` (the only text inside it), a
rounded node in the middle labelled `agent-companion`, four identical companion
nodes fanned out on the right labelled `Codex`, `OpenCode`, `Copilot`,
`Antigravity`. One line from harness to agent-companion, four lines from there
to the companions. Title `Agent Companion` top-left. Nothing else.
Kept variant: solid navy terminal with a gray frame, teal-filled centre node,
outlined companion nodes.

## architecture.png

Left-to-right diagram of the shipped design, boxes in this order:

1. `Harness (Claude Code / Codex CLI)`
2. `agent-companion subagent`
3. `agent-bridge (MCP, session scope)`
4. `Controller: one per answer`, containing `process group`, `lease`,
   `immutable result`
5. `Cold companion runtime`, containing `Codex app-server`, `OpenCode server`,
   `ACP: Antigravity, Copilot`

Above the controller: `stop hooks -> stop markers` with an arrow into the
controller. Below: `bridge loss -> cleanup watcher` with an arrow to the
runtime. Footer: `Native history survives; a follow-up resumes it cold.`
Kept variant: crisp rectangular boxes, gray outlines, teal connectors.

## target-matrix.png

Title `Companion capabilities`. Columns `Companion`, `Transport`, `Follow-up`,
`In-flight reply`, `Cancel`. Rows:

| Companion | Transport | Follow-up | In-flight reply | Cancel |
| --- | --- | --- | --- | --- |
| Codex CLI | app-server | yes | yes | yes |
| OpenCode 2.x | HTTP server | yes | no | yes |
| Google Antigravity | ACP | yes | no | yes |
| GitHub Copilot CLI | ACP | not yet | no | yes |

Keep this table in step with the capability table in README.md.
Kept variant: full gray grid, teal header row, teal `yes`, gray `no`.

## ../../.claude-plugin/icon.png

Square 1024x1024 listing icon for the Claude plugin directory, generated the
same day with the same tool. Solid #0f172a background, flat vector style, teal
(#2dd4bf) and white only. One teal-filled rounded-square node in the centre, a
single white line entering from the left, four white lines fanning out to four
small outlined rounded-square nodes stacked on the right. Smooth curved
connectors, bold strokes, rounded caps, generous padding, no frame, no text,
no logos, no gradients, no shadows.
