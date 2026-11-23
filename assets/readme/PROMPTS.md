# README image specifications

The PNGs in this directory are generated bitmaps, produced on 2026-11-23 with
Codex's built-in image tool for the 1.0.0 thread design. There is no vector
source. To regenerate, give an image model the shared style and one
specification below, then check every label against the text here before
committing; CI only checks that the files exist.

## Shared style

Flat vector-style illustration on a solid dark navy background (#0f172a).
Electric teal (#2dd4bf) as the only accent, plus white and soft gray. Clean
geometric shapes, generous whitespace. No photorealism, gradients, gloss, logos,
trademarks, watermark or text beyond the labels specified. Readable sans-serif
labels, spelled exactly as given. Landscape, 16:9 or 2:1.

## hero.png

Concept: "Your own conversation talks to any companion."
One terminal window on the left labelled `Claude Code · Codex CLI` (the only
text inside it), a rounded node in the middle labelled `agent-bridge`, five
identical companion nodes fanned out on the right labelled `Codex`,
`OpenCode`, `Copilot`, `Antigravity`, `Claude Code`. One line from the
terminal to agent-bridge, five lines from there to the companions. Title
`Agent Companion` top-left. Nothing else.
Style: solid navy terminal with a gray frame, teal-filled centre node,
outlined companion nodes.

## architecture.png

Left-to-right diagram of the shipped design, four boxes in this order:

1. `Lead` with the subtitle `your Claude Code or Codex CLI conversation`
2. `agent-bridge` with the subtitle `MCP, one per session`, containing
   `companion_* tools` and `threads th-…`
3. `Controller: one per job`, containing `process group` and
   `immutable result`
4. `Cold companion runtime`, containing `Codex app-server`, `OpenCode server`,
   `ACP: Antigravity, Copilot`, `Claude Code stream-json`

Arrows left to right between the boxes. One return arrow along the top from
the controller back to the lead, labelled
`result: hook · companion_wait · wake`. Below the controller:
`bridge loss -> cleanup watcher` with an arrow to the runtime. Footer:
`Native history survives; a follow-up on the thread resumes it cold.`
Style: crisp rectangular boxes, gray outlines, teal connectors.

## companion-matrix.png

Title `Companion capabilities`. Columns `Companion`, `Runtime`, `Follow-up`,
`Steer`, `Queue`, `Interrupt`, `Cancel`. Rows:

| Companion | Runtime | Follow-up | Steer | Queue | Interrupt | Cancel |
| --- | --- | --- | --- | --- | --- | --- |
| Codex CLI | app-server | yes | yes | yes | yes | yes |
| OpenCode 2.x | HTTP server | yes | yes | yes | yes | yes |
| Google Antigravity | ACP | yes | yes | yes | yes | yes |
| Claude Code | stream-json | yes | yes | yes | yes | yes |
| GitHub Copilot CLI | ACP | yes | no | yes | yes | yes |

Keep this table in step with the capability table in README.md.
Style: full gray grid, teal header row, teal `yes`, gray `no`.

## ../../.claude-plugin/icon.png

Square 1024x1024 listing icon for the Claude plugin directory. Solid #0f172a
background, flat vector style, teal (#2dd4bf) and white only. One teal-filled
rounded-square node in the centre, a single white line entering from the left,
five white lines fanning out to five small outlined rounded-square nodes
stacked on the right. Smooth curved connectors, bold strokes, rounded caps,
generous padding, no frame, no text, no logos, no gradients, no shadows.

## demo.gif

Not generated: a real Claude Code session recorded with vhs from `demo.tape`
in this directory (see the tape header). Convert the recording with idle
frames removed, a four-second hold on the final state and a 128-colour palette:

```bash
ffmpeg -y -i demo.mp4 -vf "mpdecimate=hi=768:lo=320:frac=0.33,setpts=N/10/TB,tpad=stop_mode=clone:stop_duration=4,scale=1000:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" -r 10 demo.gif
```
