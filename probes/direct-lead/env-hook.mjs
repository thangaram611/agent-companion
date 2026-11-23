// Records which messaging variables a hook process is given. Usage: node env-hook.mjs RUN_DIR
import fs from 'node:fs';
const run = process.argv[2];
let payload = {}; try { payload = JSON.parse(fs.readFileSync(0, 'utf8')); } catch {}
const keys = Object.keys(process.env).filter(k => /MESSAG|CLAUDE_CODE_SESSION|SOCK|PEER/i.test(k)).sort();
const socket = process.env.CLAUDE_CODE_MESSAGING_SOCKET ?? null;
fs.appendFileSync(run + '/env-hook.jsonl', JSON.stringify({ t: Date.now(), event: payload.hook_event_name, session: payload.session_id, source: payload.source ?? null, reason: payload.reason ?? null, keys,
  socket, tokenChars: (process.env.CLAUDE_CODE_MESSAGING_TOKEN ?? '').length }) + '\n');
// The token stays in a 0600 file inside the run directory so the probe can post to this session's own socket.
if (socket) fs.writeFileSync(run + '/messaging.json', JSON.stringify({ socket, token: process.env.CLAUDE_CODE_MESSAGING_TOKEN ?? null }), { mode: 0o600 });
