// Direct-main probe runner. Usage: node run.mjs NAME --seconds N --kb N [--wall N] [--model M] [--env K=V]...
// Starts an isolated headless Claude (stream-json both ways, stdin held open) whose MAIN
// conversation calls the fake job server itself. Nothing from the installed plugin loads.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const [name, ...rest] = process.argv.slice(2);
const opt = { seconds: 150, kb: 70, wall: 330, model: 'haiku', env: {}, prompt: null, extra: [], allow: [] };
for (let i = 0; i < rest.length; i += 2) {
  const key = rest[i].slice(2), value = rest[i + 1];
  if (key === 'env') { const [k, ...v] = value.split('='); opt.env[k] = v.join('='); }
  else if (key === 'arg') opt.extra.push(value);
  else if (key === 'allow') opt.allow.push(value);
  else opt[key] = ['seconds', 'kb', 'wall', 'rewake', 'rewake-kb', 'stop', 'stop-kb'].includes(key) ? Number(value) : value;
}
const run = path.join(here, 'runs', `${name}-${new Date().toISOString().replaceAll(':', '-')}`);
fs.mkdirSync(run + '/workspace', { recursive: true });
const hook = { type: 'command', command: `exec '${process.execPath}' '${here}/hook.mjs' '${run}'`, timeout: 5 };
const events = ['SessionStart', 'SessionEnd', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'UserPromptSubmit', 'Stop', 'Notification', 'SubagentStop'];
const hooks = Object.fromEntries(events.map(e => [e, [{ ...(e.includes('ToolUse') ? { matcher: '.*' } : {}), hooks: [hook] }]]));
if (opt.rewake) hooks.PostToolUse.push({ matcher: '^mcp__fixture__job_send$', hooks: [{ type: 'command', asyncRewake: true, timeout: 900,
  command: `exec '${process.execPath}' '${here}/rewake.mjs' '${run}' ${opt.rewake} ${opt['rewake-kb'] ?? 0}` }] });
if (opt.envhook) for (const e of ['SessionStart', 'PostToolUse']) hooks[e].push({ ...(e === 'PostToolUse' ? { matcher: '.*' } : {}), hooks: [{ type: 'command', timeout: 5,
  command: `exec '${process.execPath}' '${here}/env-hook.mjs' '${run}'` }] });
if (opt.stop) hooks.Stop.push({ hooks: [{ type: 'command', timeout: 900,
  command: `exec '${process.execPath}' '${here}/stop-inject.mjs' '${run}' ${opt.stop} ${opt['stop-kb'] ?? 0}` }] });
fs.writeFileSync(run + '/settings.json', JSON.stringify({ hooks }, null, 2));
fs.writeFileSync(run + '/mcp.json', JSON.stringify({ mcpServers: { fixture: {
  type: 'stdio', command: process.execPath, args: [here + '/fixture.mjs', run], timeout: 1320000, ...(opt.postback ? { env: { FIXTURE_POSTBACK: String(opt.postback), ...(opt['postback-plain'] ? { FIXTURE_POSTBACK_PLAIN: String(opt['postback-plain']) } : {}) } } : {}) } } }, null, 2));

const prompt = opt['prompt-file'] ? fs.readFileSync(opt['prompt-file'], 'utf8') : opt.prompt ?? `This is an isolated measurement against a fake job server. Follow the steps exactly.
1. Call mcp__fixture__job_send with task "probe".
2. Call mcp__fixture__job_wait with that job_id, seconds=${opt.seconds} and kb=${opt.kb}. Call it exactly once; never retry it.
3. If what comes back is a background task handle instead of the report, reply "BACKGROUNDED" with the handle and end your turn. Do not poll.
4. When the report reaches you (now or in a later turn), reply with: the complete last line of the report (it starts with END), and the number of the last "Line NNNNN" you can see. If you were told the output was saved to a file, say so, give the path, and Read only enough of it to quote its last line.`;
fs.writeFileSync(run + '/prompt.txt', prompt);

const allowed = ['PATH', 'HOME', 'USER', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY'];
const env = { ...Object.fromEntries(allowed.filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]])),
  DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', ...opt.env };
const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
  '--model', opt.model, '--max-budget-usd', '0.60', '--setting-sources', '', '--settings', run + '/settings.json',
  '--strict-mcp-config', '--mcp-config', run + '/mcp.json', '--no-session-persistence',
  '--permission-prompts', 'none', '--allowedTools', ['mcp__fixture__job_send', 'mcp__fixture__job_wait', 'Read', 'TaskOutput', 'TaskStop', ...opt.allow].join(','), ...opt.extra];
fs.writeFileSync(run + '/argv.json', JSON.stringify({ args, env: Object.keys(env), opt }, null, 2));

const child = spawn('claude', args, { cwd: run + '/workspace', env, stdio: ['pipe', 'pipe', 'pipe'] });
const stream = fs.createWriteStream(run + '/stream.jsonl');
const started = Date.now();
let results = 0, buffer = '', closing = false;
const close = why => { if (closing) return; closing = true; console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] closing stdin: ${why}`); child.stdin.end(); setTimeout(() => child.kill('SIGTERM'), 15000).unref(); };
child.stdout.on('data', chunk => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    stream.write(JSON.stringify({ t: Date.now() - started }) + '\t' + line + '\n');
    let message; try { message = JSON.parse(line); } catch { continue; }
    const at = `[${((Date.now() - started) / 1000).toFixed(1)}s]`;
    if (message.type === 'system') console.log(at, 'system', message.subtype, message.subtype === 'init' ? `v${message.claude_code_version} tools=${message.tools?.length}` : JSON.stringify(message).slice(0, 300));
    else if (message.type === 'assistant') for (const block of message.message.content)
      console.log(at, 'assistant', block.type, block.type === 'tool_use' ? `${block.name} ${JSON.stringify(block.input)}` : (block.text ?? '').slice(0, 400));
    else if (message.type === 'user') for (const block of [].concat(message.message.content))
      console.log(at, 'user', typeof block === 'string' ? block.slice(0, 300) : block.type, typeof block === 'string' ? '' : JSON.stringify(block.content ?? block.text ?? '').length + ' chars', typeof block === 'string' ? '' : JSON.stringify(block.content ?? block.text ?? '').slice(0, 300));
    else if (message.type === 'result') { results++; console.log(at, 'result', message.subtype, `turns=${message.num_turns} cost=${message.total_cost_usd}`, (message.result ?? '').slice(0, 500)); }
    else console.log(at, message.type, JSON.stringify(message).slice(0, 200));
  }
});
child.stderr.on('data', chunk => fs.appendFileSync(run + '/stderr.log', chunk));
child.on('exit', (code, signal) => { console.log(`exit code=${code} signal=${signal} results=${results} run=${run}`); process.exit(0); });
child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: prompt }, parent_tool_use_id: null }) + '\n');
setTimeout(() => close('wall'), opt.wall * 1000);
// A second result means the notification-driven turn finished; a first result after the wait's own length means it stayed in the foreground.
setInterval(() => { if (results >= 2 || (results >= 1 && Date.now() - started > (opt.seconds + 60) * 1000)) close(`results=${results}`); }, 1000);
