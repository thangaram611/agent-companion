// Probe-only owner hook: names the calling subagent as owner, or the lead session when the main conversation calls.
// Production's hooks/name-thread.sh clears `thread` for the main conversation; this is the change under test.
import fs from 'node:fs';
const { agent_id: id, session_id: session, tool_input: input } = JSON.parse(fs.readFileSync(0, 'utf8'));
const thread = typeof id === 'string' && id.trim() ? id : `lead-${session}`;
process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...input, thread } } }));
