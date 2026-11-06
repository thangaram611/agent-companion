# Recorded with vhs (https://github.com/charmbracelet/vhs). Run from this
# directory: `vhs demo.tape` writes demo.mp4 beside the tape; see PROMPTS.md
# for the GIF conversion. It is a live Claude Code session: it spends host and
# companion tokens and needs the plugin permissions installed. Paths in a tape
# must be relative; absolute paths fail to parse.
Output demo.mp4
Set Shell zsh
Set FontSize 15
Set Width 1100
Set Height 640
Set Padding 14
Set Theme "Catppuccin Mocha"
Set TypingSpeed 35ms
Set Framerate 12
Hide
Type "cd ../..; clear"
Enter
Sleep 1s
Show
Type "claude --plugin-dir ."
Enter
Sleep 10s
Type "Ask the codex companion to read lib/host.mjs in this repo and tell me, in two sentences, what AGENT_COMPANION_HOST controls."
Enter
Sleep 120s
Sleep 3s
