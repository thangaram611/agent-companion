// End-to-end direct-main proof. Usage: node e2e.mjs NAME [--sleeps N] [--wall N] [--model M]
// The MAIN conversation of an isolated headless Claude calls the REAL bridge itself; the bridge runs a free
// OpenCode model in disposable homes. No installed plugin, no operator companion home, no production code change:
// the only difference from production is lead-hook.mjs, which names the lead session as owner.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { companionEnv, repo } from '../../probes/free-backends/run.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const [name, ...rest] = process.argv.slice(2);
const opt = { sleeps: 3, wall: 480, model: 'haiku' };
for (let i = 0; i < rest.length; i += 2) opt[rest[i].slice(2)] = ['sleeps', 'wall'].includes(rest[i].slice(2)) ? Number(rest[i + 1]) : rest[i + 1];
const run = path.join(here, 'runs', `${name}-${new Date().toISOString().replaceAll(':', '-')}`);
fs.mkdirSync(run + '/workspace', { recursive: true });
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentco-direct-'));
const bridgeEnv = { ...companionEnv({ root, target: 'opencode', proxyUrl: '' }), AGENT_COMPANION_HOST: 'claude' };
const work = path.join(root, 'opencode', 'work');
for (const dir of [work, bridgeEnv.HOME, bridgeEnv.TMPDIR, bridgeEnv.XDG_CONFIG_HOME, bridgeEnv.XDG_STATE_HOME, bridgeEnv.XDG_CACHE_HOME,
  bridgeEnv.AGENT_COMPANION_HOME, path.join(bridgeEnv.XDG_DATA_HOME, 'opencode')]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
fs.writeFileSync(work + '/seed.txt', `seed ${crypto.randomUUID()}\n`);
fs.writeFileSync(run + '/root.txt', root + '\n');

const node = `'${process.execPath}'`;
const record = { type: 'command', command: `exec ${node} '${here}/hook.mjs' '${run}'`, timeout: 5 };
const events = ['SessionStart', 'SessionEnd', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'UserPromptSubmit', 'Stop'];
const hooks = Object.fromEntries(events.map(e => [e, [{ ...(e.includes('ToolUse') ? { matcher: '.*' } : {}), hooks: [record] }]]));
hooks.PreToolUse.push({ matcher: '^mcp__agent-bridge__agent_(send|wait|reply|cancel)$',
  hooks: [{ type: 'command', command: `exec ${node} '${here}/lead-hook.mjs'`, timeout: 5 }] });
fs.writeFileSync(run + '/settings.json', JSON.stringify({ hooks }, null, 2));
fs.writeFileSync(run + '/mcp.json', JSON.stringify({ mcpServers: { 'agent-bridge': {
  type: 'stdio', command: process.execPath, args: [path.join(repo, 'bridge-server/server.mjs')], env: bridgeEnv, timeout: 1320000 } } }, null, 2));

const task = `Run these shell commands one at a time, in this order, each as its own command: ${Array(opt.sleeps).fill('`sleep 50`').join(', ')}, then \`shasum -a 256 seed.txt\`.
Then answer with exactly two lines: the line PROBE-DONE, and the complete output line of the shasum command. Do not edit any file.`;
const prompt = `This is an isolated measurement. Follow the steps exactly.
1. Call mcp__agent-bridge__agent_send with cwd="${work}", target="opencode", model="opencode/flint-40b-free", and task set to exactly the text between the <task> tags, copied character for character.
<task>${task}</task>
2. Call mcp__agent-bridge__agent_wait exactly once with the returned job_id and max_wait_sec=600.
3. If that call is moved to the background, reply "BACKGROUNDED" and end your turn. Do not poll and do not call anything else.
4. When the job's result reaches you (now or in a later turn), reply "RESULT-RECEIVED", then the companion's answer exactly as it reached you, then one line saying in what form it reached you (inline tool result, task notification, or a saved file).`;
fs.writeFileSync(run + '/prompt.txt', prompt);
fs.writeFileSync(run + '/task.txt', task);

const allowed = ['PATH', 'HOME', 'USER', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY'];
const env = { ...Object.fromEntries(allowed.filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]])),
  DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_AUTO_BACKGROUND_TASKS: '1' };
const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
  '--model', opt.model, '--max-budget-usd', '0.60', '--setting-sources', '', '--settings', run + '/settings.json',
  '--strict-mcp-config', '--mcp-config', run + '/mcp.json', '--no-session-persistence', '--permission-prompts', 'none',
  '--allowedTools', ['agent_send', 'agent_wait', 'agent_status', 'agent_catalog'].map(t => 'mcp__agent-bridge__' + t).concat('Read', 'ToolSearch').join(',')];
const child = spawn('claude', args, { cwd: run + '/workspace', env, stdio: ['pipe', 'pipe', 'pipe'] });
const stream = fs.createWriteStream(run + '/stream.jsonl');
const started = Date.now();
let results = 0, buffer = '', closing = false;
const at = () => `[${((Date.now() - started) / 1000).toFixed(1)}s]`;
const close = why => { if (closing) return; closing = true; console.log(at(), 'closing stdin:', why); child.stdin.end(); setTimeout(() => child.kill('SIGTERM'), 20000).unref(); };
child.stdout.on('data', chunk => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    stream.write(JSON.stringify({ t: Date.now() - started }) + '\t' + line + '\n');
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.type === 'system' && ['hook_started', 'hook_response', 'thinking_tokens'].includes(m.subtype)) continue;
    if (m.type === 'system') console.log(at(), 'system', m.subtype, m.subtype === 'init' ? `v${m.claude_code_version}` : JSON.stringify(m).slice(0, 260));
    else if (m.type === 'assistant') for (const b of m.message.content) { if (b.type !== 'thinking') console.log(at(), 'assistant', b.type, b.type === 'tool_use' ? `${b.name} ${JSON.stringify(b.input).slice(0, 500)}` : (b.text ?? '').slice(0, 1200)); }
    else if (m.type === 'user') for (const b of [].concat(m.message.content)) console.log(at(), 'user', typeof b === 'string' ? b.slice(0, 300) : `${b.type} ${JSON.stringify(b.content ?? b.text ?? '').length} chars ${JSON.stringify(b.content ?? b.text ?? '').slice(0, 1500)}`);
    else if (m.type === 'result') { results++; console.log(at(), 'result', m.subtype, `cost=${m.total_cost_usd}`); }
  }
});
child.stderr.on('data', chunk => fs.appendFileSync(run + '/stderr.log', chunk));
child.on('exit', (code, signal) => { console.log(`exit code=${code} signal=${signal} results=${results}\nrun=${run}\nroot=${root}`); process.exit(0); });
child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: prompt }, parent_tool_use_id: null }) + '\n');
setTimeout(() => close('wall'), opt.wall * 1000);
setInterval(() => { if (results >= 2) close('second turn finished'); }, 1000);
