import { mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Records } from '../bridge-server/controller/records.mjs';
import { writePrivateFileAtomic } from '../lib/runtime-paths.mjs';
import { hookAnswer } from '../bridge-server/delivery.mjs';
import { detectHost, HOSTS, refuseRealHomeUnderTest } from '../lib/hosts/index.mjs';

const event = process.argv[2];
const { session_id: session, agent_id: agent = null, tool_input: input } = JSON.parse(readFileSync(0, 'utf8'));
const host = HOSTS[detectHost()];
const output = value => console.log(JSON.stringify({ hookSpecificOutput: value }));

if (event === 'pre-tool') {
  const lead = { session, agent };
  if (!host.leadFromCall({ args: { lead } })) throw new Error('missing host identity');
  output({ hookEventName: 'PreToolUse', updatedInput: { ...input, lead } });
} else {
  if (event === 'session-start') {
    const socket = process.env.CLAUDE_CODE_MESSAGING_SOCKET;
    const current = host.sessionFile?.(process.env);
    if (current && typeof session === 'string' && session) {
      mkdirSync(dirname(current), { recursive: true, mode: 0o700 });
      writePrivateFileAtomic(current, JSON.stringify({ socket, session, at: Date.now() }) + '\n');
    }
    const file = join(host.configDir(), 'agents', host.oldAgentFile);
    refuseRealHomeUnderTest(file, 'agent file');
    try {
      if (/^# AUTO-INSTALLED by agent-companion plugin\b/m.test(readFileSync(file, 'utf8'))) unlinkSync(file);
    } catch (err) { if (err.code !== 'ENOENT') throw err; }
  }
  if (typeof session === 'string' && session) {
    const hookEventName = { prompt: 'UserPromptSubmit', 'post-tool': 'PostToolUse', 'session-start': 'SessionStart' }[event];
    const additionalContext = hookAnswer(new Records(), { session, agent, host: host.id });
    if (additionalContext) output({ hookEventName, additionalContext });
  }
}
