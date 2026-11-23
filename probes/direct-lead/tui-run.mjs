// Prepare and start an interactive (PTY) direct-main run. Usage: node tui-run.mjs NAME --seconds N --kb N [--wall N] [--model M] [--env K=V]... [--prompt-file F]
// Prints the run directory; drive it with: node tui-send.mjs RUN "text"   and read it with: python3 screen.py RUN
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const [name, ...rest] = process.argv.slice(2);
const opt = { seconds: 150, kb: 30, wall: 420, model: 'haiku', env: {}, 'prompt-file': null, extra: [] };
for (let i = 0; i < rest.length; i += 2) {
  const key = rest[i].slice(2), value = rest[i + 1];
  if (key === 'env') { const [k, ...v] = value.split('='); opt.env[k] = v.join('='); }
  else if (key === 'arg') opt.extra.push(value);
  else opt[key] = ['seconds', 'kb', 'wall', 'rewake', 'rewake-kb', 'stop', 'stop-kb'].includes(key) ? Number(value) : value;
}
const run = path.join(here, 'runs', `${name}-${new Date().toISOString().replaceAll(':', '-')}`);
fs.mkdirSync(run + '/workspace', { recursive: true });
const hook = { type: 'command', command: `exec '${process.execPath}' '${here}/hook.mjs' '${run}'`, timeout: 5 };
const events = ['SessionStart', 'SessionEnd', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'UserPromptSubmit', 'Stop', 'Notification', 'SubagentStop'];
const hooks = Object.fromEntries(events.map(e => [e, [{ ...(e.includes('ToolUse') ? { matcher: '.*' } : {}), hooks: [hook] }]]));
if (opt.rewake) hooks.PostToolUse.push({ matcher: '^mcp__fixture__job_send$', hooks: [{ type: 'command', asyncRewake: true, timeout: 900,
  command: `exec '${process.execPath}' '${here}/rewake.mjs' '${run}' ${opt.rewake} ${opt['rewake-kb'] ?? 0}` }] });
if (opt.envhook) for (const e of ['SessionStart', 'PostToolUse', 'SessionEnd']) hooks[e].push({ ...(e === 'PostToolUse' ? { matcher: '.*' } : {}), hooks: [{ type: 'command', timeout: 5,
  command: `exec '${process.execPath}' '${here}/env-hook.mjs' '${run}'` }] });
if (opt.stop) hooks.Stop.push({ hooks: [{ type: 'command', timeout: 900,
  command: `exec '${process.execPath}' '${here}/stop-inject.mjs' '${run}' ${opt.stop} ${opt['stop-kb'] ?? 0}` }] });
fs.writeFileSync(run + '/settings.json', JSON.stringify({ hooks }, null, 2));
fs.writeFileSync(run + '/mcp.json', JSON.stringify({ mcpServers: { fixture: {
  type: 'stdio', command: process.execPath, args: [here + '/' + (opt.fixture ?? 'fixture.mjs'), run], timeout: 1320000 } } }, null, 2));
const prompt = opt['prompt-file'] ? fs.readFileSync(opt['prompt-file'], 'utf8') : `This is an isolated measurement against a fake job server. Follow the steps exactly.
1. Call mcp__fixture__job_send with task "probe".
2. Call mcp__fixture__job_wait with that job_id, seconds=${opt.seconds} and kb=${opt.kb}. Call it exactly once; never retry it and never call it again.
3. If what comes back is a background task handle instead of the report, reply "BACKGROUNDED" with the handle and end your turn. Do not poll, do not sleep, do not call any tool to check on it.
4. When the report reaches you (now or in a later turn), reply with "REPORT-RECEIVED", then the complete last line of the report (it starts with END), and the number of the last "Line NNNNN" you can see. If you were told the output was saved to a file, say so and give the path, and Read only enough of it to quote its last line.`;
fs.writeFileSync(run + '/prompt.txt', prompt);
const allowed = ['PATH', 'HOME', 'USER', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY'];
const env = { ...Object.fromEntries(allowed.filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]])),
  TERM: 'xterm-256color', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', ...opt.env };
const sessionId = crypto.randomUUID();
const args = ['--model', opt.model, '--session-id', sessionId, '--setting-sources', '', '--settings', run + '/settings.json',
  '--strict-mcp-config', '--mcp-config', run + '/mcp.json',
  '--allowedTools', 'mcp__fixture__job_send,mcp__fixture__job_wait,Read,TaskOutput,TaskStop,ToolSearch', ...opt.extra, '--', prompt];
fs.writeFileSync(run + '/command.json', JSON.stringify({ executable: 'claude', args, cwd: run + '/workspace', env, wallSec: opt.wall, sessionId }, null, 2));
const out = fs.openSync(run + '/driver.log', 'a');
const child = spawn('python3', [here + '/tui.py', run], { detached: true, stdio: ['ignore', out, out] });
child.unref();
console.log(run);
