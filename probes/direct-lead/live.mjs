// Integrated live checks for docs/THREAD_PLAN.md steps 3 to 7, on a Claude Code or Codex CLI host.
// The bridge is this checkout's; its companion is Codex on the scripted model (codex/fake-model.mjs), so a job costs
// nothing; the Claude host is Haiku (budget-capped). The hooks are the plugin's own. Every home is a fresh temp dir.
// Usage: node live.mjs <claude|codex> <scenario> [--wall SECONDS] [--idle SECONDS] [--inprocess 1]
//   smoke     send, wait and the answer
//   read70    a 70,000-character answer read in full through companion_read, compared with the stored result
//   esc       a pending companion_wait is cancelled; the job runs on and a later wait returns its result
//   wake      the lead ends its turn; the finished job wakes it and the prompt hook brings the answer
//   recurse   the companion has the bridge loaded and calls companion_send; it is refused
//   busy      the lead is in a long tool call when the job ends; it gets the answer after the call
//   burst     two jobs end together; the hook delivers both
//   clear     /clear (Claude) or /new (Codex) while a job runs; see the scenario for what each host does
//   twoleads  two leads in one project each get only their own result
//   pane      (claude) the mod's band, the /companion pane, a card's job view and a message sent from it
// The Codex TUI runs through its home's app-server daemon, as installed; --inprocess 1 keeps it in the TUI.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const [host, scenario, ...rest] = process.argv.slice(2);
const opt = { wall: 600, idle: 40 };
for (let i = 0; i < rest.length; i += 2) opt[rest[i].slice(2)] = Number(rest[i + 1]);
const started = Date.now();
const at = () => `[${((Date.now() - started) / 1000).toFixed(1)}s]`;
const log = (...args) => console.log(at(), ...args);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// --- Isolated homes, the scripted model and the bridge's environment ---------------------------------------------
const root = fs.mkdtempSync(path.join(os.tmpdir(), `agentco-live-${host}-${scenario}-`));
const dirs = Object.fromEntries(['home', 'state', 'companion', 'host', 'work', 'model', 'tmp']
  .map(name => [name, path.join(root, name)]));
// A Codex host and its Codex companion share one home, as they do installed: `codex queue` must reach the host.
if (host === 'codex') dirs.host = dirs.companion;
for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(dirs.work, 'seed.txt'), `seed ${randomUUID()}\n`);
const model = spawn(process.execPath, [path.join(here, 'codex/fake-model.mjs'), dirs.model], { stdio: ['ignore', 'pipe', 'inherit'] });
const port = await new Promise(resolve => model.stdout.once('data', chunk => resolve(String(chunk).trim())));
const provider = `model = "probe-model"\nmodel_provider = "probe"\n\n[model_providers.probe]\nname = "Probe"\nbase_url = "http://127.0.0.1:${port}/v1"\nwire_api = "responses"\n`;
const bridgeEnv = { PATH: process.env.PATH, HOME: dirs.home, TMPDIR: dirs.tmp, LANG: 'en_US.UTF-8', CODEX_HOME: dirs.companion,
  AGENT_COMPANION_HOME: dirs.state, AGENT_COMPANION_HOST: host };
const bridge = [process.execPath, path.join(repo, 'bridge-server/server.mjs')];
const toml = value => JSON.stringify(value);
const envToml = env => Object.entries(env).map(([key, value]) => `${key} = ${toml(value)}`).join('\n');
// The companion's Codex: the scripted model; with `recurse`, this checkout's bridge loaded as a Codex plugin would be.
fs.writeFileSync(path.join(dirs.companion, 'config.toml'), provider + (scenario === 'recurse'
  ? `\n[mcp_servers.agent_bridge]\ncommand = ${toml(bridge[0])}\nargs = [${toml(bridge[1])}]\ndefault_tools_approval_mode = "approve"\n\n[mcp_servers.agent_bridge.env]\n${envToml({ ...bridgeEnv, AGENT_COMPANION_HOST: 'codex' })}\n` : ''));
log('root', root);

// The plugin's own hooks, pointed at the isolated homes (the runtime dir follows HOME).
function pluginHooks(manifest, rootVar) {
  const isolate = `HOME='${dirs.home}' AGENT_COMPANION_HOME='${dirs.state}' AGENT_COMPANION_HOST=${host} ${rootVar}='${repo}'`;
  const hooks = {};
  for (const [event, groups] of Object.entries(JSON.parse(fs.readFileSync(path.join(repo, 'hooks', manifest), 'utf8')).hooks)) {
    for (const group of groups) {
      const shipped = group.hooks.filter(h => !h.command.includes('install-deps.sh'))
        .map(h => ({ ...h, command: `${isolate} ${h.command.replaceAll('${' + rootVar + '}', repo)}` }));
      if (shipped.length) (hooks[event] ??= []).push({ ...group, hooks: shipped });
    }
  }
  return hooks;
}

// --- Claude Code host: headless stream-json, stdin held open --------------------------------------------------------
function claudeHost(name = 'lead') {
  const session = randomUUID();
  fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({ hooks: pluginHooks('hooks.json', 'CLAUDE_PLUGIN_ROOT') }, null, 2));
  fs.writeFileSync(path.join(root, 'mcp.json'), JSON.stringify({ mcpServers: { 'agent-bridge': {
    type: 'stdio', command: bridge[0], args: [bridge[1]], env: bridgeEnv, timeout: 1320000 } } }, null, 2));
  const allowed = ['PATH', 'HOME', 'USER', 'SHELL', 'TMPDIR', 'LANG', 'TERM', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY'];
  const env = { ...Object.fromEntries(allowed.filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]])),
    DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_AUTO_BACKGROUND_TASKS: '1' };
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--model', 'haiku',
    '--max-budget-usd', '0.80', '--session-id', session, '--setting-sources', '', '--settings', path.join(root, 'settings.json'),
    '--strict-mcp-config', '--mcp-config', path.join(root, 'mcp.json'), '--permission-prompts', 'none',
    '--allowedTools', 'mcp__agent-bridge,Bash,Read,ToolSearch'];
  const child = spawn('claude', args, { cwd: dirs.work, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const stream = fs.createWriteStream(path.join(root, `${name}-stream.jsonl`));
  const messages = [];
  let buffer = '';
  child.stdout.on('data', chunk => {
    buffer += chunk;
    for (let i; (i = buffer.indexOf('\n')) >= 0;) {
      const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
      if (!line.trim()) continue;
      stream.write(line + '\n');
      let m; try { m = JSON.parse(line); } catch { continue; }
      messages.push(m);
      if (m.type === 'assistant') for (const b of m.message.content) {
        if (b.type === 'tool_use') log(name, 'calls', b.name, JSON.stringify(b.input).slice(0, 200));
        else if (b.type === 'text') log(name, 'says', b.text.slice(0, 300).replaceAll('\n', ' | '));
      } else if (m.type === 'user') for (const b of [].concat(m.message.content)) {
        if (typeof b === 'string') log('user', b.slice(0, 200).replaceAll('\n', ' | '));
        else if (b.type === 'tool_result') log('tool result', JSON.stringify(b.content).length, 'chars', JSON.stringify(b.content).slice(0, 200));
        else if (b.type === 'text') log('user text', b.text.slice(0, 300).replaceAll('\n', ' | '));
      } else if (m.type === 'result') log('turn ends', m.subtype, `cost=${m.total_cost_usd}`);
      else if (m.type === 'system' && !['hook_started', 'hook_response', 'thinking_tokens'].includes(m.subtype)) log('system', m.subtype);
    }
  });
  child.stderr.on('data', chunk => fs.appendFileSync(path.join(root, 'stderr.log'), chunk));
  const exited = new Promise(resolve => child.on('exit', resolve));
  return {
    session, messages, exited,
    said: () => messages.filter(m => m.type === 'assistant').flatMap(m => m.message.content.filter(b => b.type === 'text').map(b => b.text)).join('\n'),
    say: text => child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null }) + '\n'),
    // The SDK's interrupt, what Esc does in the terminal.
    interrupt: () => child.stdin.write(JSON.stringify({ type: 'control_request', request_id: randomUUID(), request: { subtype: 'interrupt' } }) + '\n'),
    turns: () => messages.filter(m => m.type === 'result').length,
    toolResults: name => {
      const ids = new Set(messages.flatMap(m => m.type === 'assistant' ? m.message.content.filter(b => b.type === 'tool_use' && b.name.endsWith(name)).map(b => b.id) : []));
      return messages.flatMap(m => m.type === 'user' ? [].concat(m.message.content).filter(b => b.type === 'tool_result' && ids.has(b.tool_use_id))
        .map(b => typeof b.content === 'string' ? b.content : b.content.map(part => part.text ?? '').join('')) : []);
    },
    close: () => { child.stdin.end(); setTimeout(() => child.kill('SIGTERM'), 20_000).unref(); },
  };
}

// --- Codex CLI host: the scripted model drives it; tool outputs are read back from its requests ----------------------
function codexHome() {
  fs.writeFileSync(path.join(dirs.host, 'config.toml'), `${provider}approval_policy = "never"\nsandbox_mode = "read-only"\n\n[mcp_servers.agent_bridge]\ncommand = ${toml(bridge[0])}\nargs = [${toml(bridge[1])}]\ndefault_tools_approval_mode = "approve"\ntool_timeout_sec = 1320\nstartup_timeout_sec = 120\n\n[mcp_servers.agent_bridge.env]\n${envToml(bridgeEnv)}\n\n[projects.${toml(dirs.work)}]\ntrust_level = "trusted"\n`);
  fs.writeFileSync(path.join(dirs.host, 'hooks.json'), JSON.stringify({ hooks: pluginHooks('hooks-codex.json', 'PLUGIN_ROOT') }, null, 2));
  return { PATH: process.env.PATH, HOME: path.join(root, 'host-home'), CODEX_HOME: dirs.host, TMPDIR: dirs.tmp, LANG: 'en_US.UTF-8', TERM: 'xterm-256color' };
}
function codexExec(prompt, wall = opt.wall) {
  const env = codexHome();
  fs.mkdirSync(env.HOME, { recursive: true });
  const run = spawnSync('codex', ['exec', '--dangerously-bypass-hook-trust', '--skip-git-repo-check', '-C', dirs.work, prompt],
    { cwd: dirs.work, env, encoding: 'utf8', timeout: wall * 1000, input: '' });
  fs.writeFileSync(path.join(root, 'codex-exec.out'), (run.stdout ?? '') + (run.stderr ?? ''));
  log('codex exec exit', run.status, run.signal ?? '');
  return run;
}
// The interactive TUI under the scripted PTY host (tui.py): `type` sends keystrokes, `stop` ends it.
// By default it runs as installed: through the home's managed app-server daemon, which then owns the bridge and runs
// the hooks, with the hooks trusted at the prompt. `--inprocess 1` bypasses hook trust, which keeps the server in the TUI.
let daemonStop = null;
function codexTui(prompt, wall = opt.wall, name = '') {
  const env = codexHome(), pty = name ? path.join(root, name) : root;
  fs.mkdirSync(env.HOME, { recursive: true });
  fs.mkdirSync(pty, { recursive: true });
  fs.writeFileSync(path.join(pty, 'command.json'), JSON.stringify({ executable: 'codex',
    args: [...opt.inprocess ? ['--dangerously-bypass-hook-trust'] : [], '-C', dirs.work, prompt], cwd: dirs.work, env, wallSec: wall }));
  const child = spawn('python3', [path.join(here, 'tui.py'), pty], { stdio: 'ignore' });
  const stop = () => { fs.writeFileSync(path.join(pty, 'stop'), ''); setTimeout(() => child.kill(), 5000).unref(); };
  cleanups.push(stop);
  if (!daemonStop) cleanups.push(daemonStop = () => {
    spawnSync('codex', ['app-server', 'daemon', 'stop'], { env, timeout: 20_000 });
    // Whatever the daemon leaves, matched only by this run's root in its command line.
    spawnSync('sh', ['-c', `ps -axo pid=,command= | grep -F '${root}/' | grep -v grep | awk '{print $1}' | xargs kill 2>/dev/null`]);
  });
  const type = text => fs.appendFileSync(path.join(pty, 'tui-input.jsonl'), JSON.stringify({ text }) + '\n');
  // A line and its Enter in one write arrive as a paste; Enter on its own submits.
  const submit = async text => { type(text); await sleep(1000); type('\r'); };
  if (!opt.inprocess) {
    const screen = () => { try { return fs.readFileSync(path.join(pty, 'terminal.log'), 'utf8').replace(/\x1b\[[0-9;?<>=]*[A-Za-z~]|\s/g, ''); } catch { return ''; } };
    until(() => screen().includes('Trustallandcontinue'), 'the hook trust prompt', 30_000).then(() => submit('2'), () => {});
  }
  return { type, stop, submit };
}
// Every request the scripted model got from the host (its input carries the host's tool outputs and hook text).
const hostRequests = () => fs.readdirSync(path.join(dirs.model, 'model-requests')).sort()
  .map(file => JSON.parse(fs.readFileSync(path.join(dirs.model, 'model-requests', file), 'utf8')).body)
  .filter(body => JSON.stringify(body?.input ?? '').includes('companion_send'));
// Each tool output the host model was sent, in order, from the scripted model's request log.
function codexToolOutputs() {
  const files = fs.readdirSync(path.join(dirs.model, 'model-requests')).sort();
  const last = files.map(file => JSON.parse(fs.readFileSync(path.join(dirs.model, 'model-requests', file), 'utf8')).body)
    .filter(body => body?.input?.some?.(item => /PROBE-(CALL|PAGES) /.test(JSON.stringify(item.content ?? '')))).at(-1);
  return (last?.input ?? []).filter(item => /_output$/.test(item.type ?? ''))
    // Codex puts a "Wall time" part before the tool's own text blocks.
    .map(item => typeof item.output === 'string' ? item.output
      : item.output.filter(part => !/^Wall time: /.test(part.text ?? '')).map(part => part.text ?? '').join('\n'));
}

// --- Records ----------------------------------------------------------------------------------------------------
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const records = kind => { try { return fs.readdirSync(path.join(dirs.state, kind)).filter(f => f.endsWith('.json')).map(f => readJson(path.join(dirs.state, kind, f))); } catch { return []; } };
async function until(predicate, label, ms = opt.wall * 1000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await predicate()) return true; await sleep(500); }
  throw new Error(`timed out waiting for ${label}`);
}
const verdicts = [], cleanups = [];
const check = (ok, what) => { verdicts.push([ok, what]); log(ok ? 'PASS' : 'FAIL', what); };

// The rendered posts companion_read returned, footers removed, then the post's two header lines.
function readBack(pages) {
  const text = pages.map(page => page.slice(0, page.lastIndexOf('\n['))).join('');
  return text.split('\n').slice(2).join('\n');
}

const scenarios = {
  // The harness itself: a short answer through send and wait.
  async smoke() {
    const task = 'PROBE-ANSWER 2000';
    if (host === 'claude') {
      const lead = claudeHost();
      lead.say(`Call mcp__agent-bridge__companion_send with cwd="${dirs.work}", companion="codex" and task="${task}", then mcp__agent-bridge__companion_wait with the returned thread, then reply SMOKE-DONE.`);
      await until(() => lead.turns() >= 1, 'the lead');
      lead.close();
    } else codexExec([`PROBE-CALL companion_send ${JSON.stringify({ cwd: dirs.work, companion: 'codex', task })}`, 'PROBE-CALL companion_wait {"thread":"$THREAD","max_wait_sec":120}'].join('\n'));
    const [result] = records('results');
    check(result?.outcome === 'completed' && result.text.length === 2000, `the companion answered 2000 characters (${result?.outcome}, ${result?.text?.length})`);
  },
  async read70() {
    const task = 'PROBE-ANSWER 70000';
    if (host === 'claude') {
      const lead = claudeHost();
      lead.say(`This is an isolated measurement. Follow the steps exactly and do nothing else.
1. Call mcp__agent-bridge__companion_send with cwd="${dirs.work}", companion="codex" and task="${task}".
2. Call mcp__agent-bridge__companion_wait with the returned thread and max_wait_sec=300.
3. Call mcp__agent-bridge__companion_read with that thread. While the last line of its result names a next offset, call companion_read again with the thread and that offset. Stop when the last line starts with "[end".
4. Reply READ-DONE and nothing else.`);
      await until(() => lead.turns() >= 1, 'the lead to finish reading');
      lead.close();
      var pages = lead.toolResults('companion_read');
    } else {
      codexExec([`PROBE-CALL companion_send ${JSON.stringify({ cwd: dirs.work, companion: 'codex', task })}`,
        'PROBE-CALL companion_wait {"thread":"$THREAD","max_wait_sec":300}', 'PROBE-PAGES companion_read {"thread":"$THREAD"}'].join('\n'));
      var pages = codexToolOutputs().slice(2);
    }
    const [result] = records('results');
    log('pages', pages.length, pages.map(p => p.length).join(' '));
    check(result?.text?.length === 70000, `the stored result has 70000 characters (${result?.text?.length})`);
    check(readBack(pages) === result?.text, 'the pages put back together equal the stored result byte for byte');
  },
};

const directives = lines => lines.map(([kind, tool, args]) => `${kind} ${tool} ${JSON.stringify(args)}`).join('\n');
const job = (task, fields = {}) => ({ cwd: dirs.work, companion: 'codex', task, ...fields });
const threadOf = () => records('threads')[0];
const answerOf = () => records('results')[0];

Object.assign(scenarios, {
  // The lead ends its turn; the finished job wakes it, and the wake's own prompt hook brings the answer.
  async wake() {
    const task = `PROBE-DELAY ${opt.idle}\nPROBE-ANSWER 300`;
    if (host === 'claude') {
      const lead = claudeHost();
      lead.say(`This is an isolated measurement. Call mcp__agent-bridge__companion_send with cwd="${dirs.work}", companion="codex" and task=${JSON.stringify(task)} (the \\n is a newline). Do not call companion_wait. Reply SENT and end your turn.
Later a message about that thread will arrive. Then reply WOKE, then the first line of the companion's answer exactly as it reached you, then where it reached you from.`);
      await until(() => lead.turns() >= 1, 'the send turn');
      const ack = JSON.parse(lead.toolResults('companion_send')[0]);
      check(ack.delivery?.wake === 'inbox_socket', `the send says the inbox socket is armed (${JSON.stringify(ack.delivery)})`);
      await until(() => lead.turns() >= 2, 'the wake', (opt.idle + 300) * 1000);
      lead.close();
      const said = lead.messages.filter(m => m.type === 'assistant').flatMap(m => m.message.content.filter(b => b.type === 'text').map(b => b.text)).join('\n');
      check(/WOKE/.test(said) && said.includes('line 000001'), 'the lead woke and quoted the answer');
    } else {
      const tui = codexTui(directives([['PROBE-CALL', 'companion_send', job(task)]]), opt.idle + 600);
      await until(() => codexToolOutputs().length >= 1, 'the send turn', 120_000);
      const ack = JSON.parse(codexToolOutputs()[0]);
      check(ack.delivery?.wake === 'codex_queue', `the send says codex queue is armed (${JSON.stringify(ack.delivery)})`);
      await until(() => answerOf(), 'the result', (opt.idle + 300) * 1000);
      await until(() => hostRequests().some(body => JSON.stringify(body.input).includes('line 000001')), 'the woken turn', 120_000);
      tui.stop();
      check(true, 'the woken turn carried the answer to the host model');
    }
    const delivered = fs.readFileSync(path.join(dirs.state, 'results', answerOf().jobId + '.json.delivery'), 'utf8').trim();
    check(delivered === 'hook', `the prompt hook delivered it (${delivered})`);
  },
  // A pending wait is cancelled; the job runs on and a later wait returns its result.
  async esc() {
    const task = `PROBE-DELAY 45\nPROBE-ANSWER 300`;
    if (host === 'claude') {
      const lead = claudeHost();
      lead.say(`Call mcp__agent-bridge__companion_send with cwd="${dirs.work}", companion="codex" and task=${JSON.stringify(task)} (the \\n is a newline), then mcp__agent-bridge__companion_wait with the returned thread and max_wait_sec=300.`);
      await until(() => lead.toolResults('companion_send').length && lead.messages.some(m => m.type === 'assistant' && m.message.content.some(b => b.type === 'tool_use' && b.name.endsWith('companion_wait'))), 'the pending wait', 120_000);
      await sleep(5000);
      lead.interrupt();
      await until(() => lead.turns() >= 1, 'the interrupted turn', 60_000);
      await sleep(3000);
      check(!answerOf() && records('jobs')[0].state === 'running', 'after the interrupt the job is still running with no result');
      lead.say(`Call mcp__agent-bridge__companion_wait with thread="${threadOf().thread}" and max_wait_sec=300, then reply with the first line of the answer.`);
      await until(() => lead.turns() >= 2, 'the second wait', 300_000);
      lead.close();
      const waited = lead.toolResults('companion_wait').at(-1) ?? '';
      check(waited.startsWith('line 000001'), 'the later wait returned the answer');
    } else {
      const tui = codexTui(directives([['PROBE-CALL', 'companion_send', job(task)], ['PROBE-CALL', 'companion_wait', { thread: '$THREAD', max_wait_sec: 300 }]]), 600);
      await until(() => threadOf() && records('jobs')[0]?.state === 'running', 'the job', 120_000);
      await sleep(8000);
      tui.type('\x1b');
      await sleep(5000);
      check(!answerOf() && records('jobs')[0].state === 'running', 'after Esc the job is still running with no result');
      await tui.submit(directives([['PROBE-CALL', 'companion_wait', { thread: threadOf().thread, max_wait_sec: 300 }]]));
      await until(() => answerOf(), 'the result', 300_000);
      await until(() => hostRequests().some(body => body.input.some(item => /_output$/.test(item.type ?? '') && JSON.stringify(item.output).includes('line 000001'))), 'the later wait', 120_000);
      tui.stop();
      check(true, 'the later wait returned the answer to the host model');
    }
    check(answerOf().cause === 'native_complete', `the job ended on its own (${answerOf().cause})`);
  },
  // The companion has the bridge loaded (as an installed plugin would give it) and calls companion_send: refused.
  async recurse() {
    const inner = JSON.stringify({ cwd: dirs.work, companion: 'codex', task: 'PROBE-ANSWER 10' });
    const task = `PROBE-CALL companion_send ${inner}`;
    if (host === 'claude') {
      const lead = claudeHost();
      lead.say(`Call mcp__agent-bridge__companion_send with cwd="${dirs.work}", companion="codex" and task=${JSON.stringify(task)}, then mcp__agent-bridge__companion_wait with the returned thread and max_wait_sec=120, then reply DONE.`);
      await until(() => lead.turns() >= 1, 'the lead', 300_000);
      lead.close();
    } else codexExec(directives([['PROBE-CALL', 'companion_send', job(task)], ['PROBE-CALL', 'companion_wait', { thread: '$THREAD', max_wait_sec: 120 }]]));
    const outputs = fs.readdirSync(path.join(dirs.model, 'model-requests')).map(file => fs.readFileSync(path.join(dirs.model, 'model-requests', file), 'utf8'));
    check(outputs.some(text => text.includes('RECURSION_REFUSED')), "the companion's own companion_send came back RECURSION_REFUSED");
    check(records('threads').length === 1, `only the lead's thread exists (${records('threads').length})`);
  },
});

// Requests from a Codex host whose input mentions `text` (a task only that host sent).
const requestsWith = text => fs.readdirSync(path.join(dirs.model, 'model-requests')).sort()
  .map(file => fs.readFileSync(path.join(dirs.model, 'model-requests', file), 'utf8')).filter(raw => raw.includes(text));
const receipt = job => { try { return fs.readFileSync(path.join(dirs.state, 'results', job + '.json.delivery'), 'utf8').trim(); } catch { return null; } };
const resultsDone = n => records('results').length >= n;
const wakeLine = 'When a message about one of your threads arrives later, reply WOKE, the thread id, and the first line of its answer exactly as it reached you.';
// The lead's reply to a wake, not its promise to give one.
const woke = lead => /^WOKE\s+th-/m.test(lead.said());

Object.assign(scenarios, {
  // A lead busy in a long tool call still gets the result once the call ends.
  async busy() {
    const task = 'PROBE-DELAY 10\nPROBE-ANSWER 300';
    if (host === 'claude') {
      const lead = claudeHost();
      lead.say(`Call mcp__agent-bridge__companion_send with cwd="${dirs.work}", companion="codex" and task=${JSON.stringify(task)} (the \\n is a newline). Then run the shell command \`perl -e 'sleep 40'\` with Bash in the foreground. Then reply DONE and end your turn. ${wakeLine}`);
      await until(() => resultsDone(1) && woke(lead), 'the wake after the busy call', 300_000);
      lead.close();
      check(lead.said().includes('line 000001'), 'the busy lead got the answer after its call');
    } else {
      const tui = codexTui(directives([['PROBE-CALL', 'companion_send', job(task)], ['PROBE-CALL', 'exec_command', { cmd: 'sleep 40', yield_time_ms: 60000 }]]), 600);
      await until(() => resultsDone(1), 'the result', 300_000);
      await until(() => requestsWith('line 000001').length, 'the woken turn', 300_000);
      tui.stop();
      check(true, 'the busy root got the answer in a turn after its call');
    }
    check(receipt(answerOf().jobId) === 'hook', `the hook delivered it (${receipt(answerOf().jobId)})`);
  },
  // Two results finishing together: both reach the lead.
  async burst() {
    const tasks = ['PROBE-DELAY 25\nPROBE-ANSWER 300', 'PROBE-DELAY 25\nPROBE-ANSWER 400'];
    if (host === 'claude') {
      const lead = claudeHost();
      lead.say(`Call mcp__agent-bridge__companion_send twice, each starting a new thread (no thread argument), both with cwd="${dirs.work}" and companion="codex": first task=${JSON.stringify(tasks[0])}, then task=${JSON.stringify(tasks[1])} (each \\n is a newline). Do not wait. Reply SENT and end your turn. ${wakeLine}`);
      await until(() => resultsDone(2) && records('threads').every(c => lead.said().includes(c.thread)), 'both wakes', 300_000);
      lead.close();
    } else {
      const tui = codexTui(directives(tasks.map(task => ['PROBE-CALL', 'companion_send', job(task)])), 600);
      await until(() => resultsDone(2), 'both results', 300_000);
      await until(() => records('results').every(r => receipt(r.jobId) === 'hook'), 'both deliveries', 300_000);
      tui.stop();
    }
    check(records('results').every(r => receipt(r.jobId) === 'hook'), 'both results were delivered by the hook');
  },
  // After /clear, Claude wakes nothing for the old conversation; its thread stays on record for the companion page.
  // After /new, Codex keeps the conversation it left loaded until it has been idle about a minute with no client, then
  // shuts it down, closing its bridge: a job ending within that minute wakes that conversation unseen and its hook
  // delivers there; a job still running is stopped by bridge loss. Both threads stay on record.
  async clear() {
    if (host === 'claude') {
      const lead = claudeHost();
      lead.say(`Call mcp__agent-bridge__companion_send with cwd="${dirs.work}", companion="codex" and task=${JSON.stringify('PROBE-DELAY 30\nPROBE-ANSWER 300')} (the \\n is a newline). Do not wait. Reply SENT and end your turn.`);
      await until(() => lead.turns() >= 1, 'the send turn', 120_000);
      lead.say('/clear');
      await until(() => lead.messages.some(m => m.type === 'system' && m.subtype === 'init' && m.session_id !== lead.session), 'the cleared session', 60_000).catch(() => {});
      const turns = lead.turns();
      await until(() => resultsDone(1), 'the result', 300_000);
      await sleep(20_000);
      lead.close();
      check(lead.turns() === turns, `no turn after /clear (${turns} -> ${lead.turns()})`);
      check(receipt(answerOf().jobId) === null && threadOf(), 'the result is undelivered and the thread stays on record');
    } else {
      const tui = codexTui(directives([['PROBE-CALL', 'companion_send', job('PROBE-DELAY 20\nPROBE-ANSWER 300')],
        ['PROBE-CALL', 'companion_send', job('PROBE-DELAY 300\nPROBE-ANSWER 400')]]), 600);
      await until(() => codexToolOutputs().length >= 2, 'the two sends', 120_000);
      const left = records('threads')[0].lead.session;
      await tui.submit('/new');
      await until(() => resultsDone(2), 'both results', 300_000);
      tui.stop();
      const [quick, long] = ['PROBE-DELAY 20', 'PROBE-DELAY 300'].map(task => records('results')
        .find(r => records('jobs').find(e => e.jobId === r.jobId)?.text?.startsWith(task)));
      const bodies = requestsWith('line 000001').map(raw => JSON.parse(raw).body);
      check(receipt(quick?.jobId) === 'hook' && bodies.length && bodies.every(body => body.prompt_cache_key === left),
        'the job that ended within the minute woke the conversation left behind, and only that one');
      check(long?.outcome === 'stopped' && long?.cause === 'bridge_loss', `the job still running when Codex shut that conversation down was stopped (${long?.outcome} ${long?.cause})`);
      check(records('threads').length === 2, 'both threads stay on record');
    }
  },
  // Two leads in one project: each receives only its own result.
  async twoleads() {
    const tasks = ['PROBE-DELAY 20\nPROBE-ANSWER 300', 'PROBE-DELAY 25\nPROBE-ANSWER 400'];
    if (host === 'claude') {
      const leads = ['lead-a', 'lead-b'].map(name => claudeHost(name));
      leads.forEach((lead, i) => lead.say(`Call mcp__agent-bridge__companion_send with cwd="${dirs.work}", companion="codex" and task=${JSON.stringify(tasks[i])} (the \\n is a newline). Do not wait. Reply SENT and end your turn. ${wakeLine}`));
      await until(() => resultsDone(2) && leads.every(woke), 'both wakes', 300_000);
      leads.forEach(lead => lead.close());
      const own = lead => records('threads').filter(c => c.lead.session === lead.session).map(c => c.thread);
      check(leads.every(lead => own(lead).length === 1 && lead.said().includes(own(lead)[0])
        && records('threads').every(c => own(lead).includes(c.thread) || !lead.said().includes(c.thread))), 'each lead was woken with its own thread only');
    } else {
      const tuis = tasks.map((task, i) => codexTui(directives([['PROBE-CALL', 'companion_send', job(task)]]), 600, `lead-${i}`));
      await until(() => resultsDone(2) && records('results').every(r => receipt(r.jobId) === 'hook'), 'both deliveries', 300_000);
      tuis.forEach(tui => tui.stop());
      // Each root's conversation carries its own thread's answer, and no conversation carries both threads.
      const threads = records('threads').map(c => c.thread);
      check(new Set(records('threads').map(c => c.lead.session)).size === 2, 'two leads own one thread each');
      check(threads.every(t => requestsWith(t).some(raw => raw.includes('line 000001'))), "each root received its thread's answer");
      check(!requestsWith(threads[0]).some(raw => raw.includes(threads[1])), "no root saw the other's thread");
    }
  },
  // Step 7, in a Claude Code terminal with the plugin's mod: the band lists the running thread above the prompt,
  // /companion opens the session's card, the card opens the job, and a message typed there reaches the job.
  // The plugin is a copy without its MCP server or dependency install, under another name, so nothing writes the real
  // plugin data; its hooks point at the isolated homes and the bridge comes from --mcp-config.
  async pane() {
    const plugin = path.join(root, 'plugin'), hooks = path.join(plugin, 'hooks');
    fs.mkdirSync(path.join(plugin, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(path.join(plugin, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'agent-companion-probe', version: '0.0.0' }));
    // Copies, not links: the engine refuses a mod file that resolves outside the plugin's folder.
    for (const dir of ['hooks', 'bridge-server', 'lib']) fs.cpSync(path.join(repo, dir), path.join(plugin, dir), { recursive: true, filter: from => !from.includes('node_modules') });
    fs.writeFileSync(path.join(hooks, 'hooks.json'), JSON.stringify({ modules: ['./mod.ts'], hooks: pluginHooks('hooks.json', 'CLAUDE_PLUGIN_ROOT') }, null, 2));
    fs.writeFileSync(path.join(root, 'mcp.json'), JSON.stringify({ mcpServers: { 'agent-bridge': { type: 'stdio', command: bridge[0], args: [bridge[1]], env: bridgeEnv, timeout: 1320000 } } }));
    const keep = ['PATH', 'HOME', 'USER', 'SHELL', 'TMPDIR', 'LANG', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY'];
    const env = { ...Object.fromEntries(keep.filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]])),
      TERM: 'xterm-256color', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', AGENT_COMPANION_HOME: dirs.state };
    fs.writeFileSync(path.join(root, 'command.json'), JSON.stringify({ executable: 'claude', cwd: dirs.work, env, wallSec: opt.wall,
      args: ['--model', 'haiku', '--setting-sources', '', '--strict-mcp-config', '--mcp-config', path.join(root, 'mcp.json'),
        '--plugin-dir', plugin, '--allowedTools', 'mcp__agent-bridge,ToolSearch'] }));
    const child = spawn('python3', [path.join(here, 'tui.py'), root], { stdio: 'ignore' });
    cleanups.push(() => { fs.writeFileSync(path.join(root, 'stop'), ''); setTimeout(() => child.kill(), 5000).unref(); });
    const type = text => fs.appendFileSync(path.join(root, 'tui-input.jsonl'), JSON.stringify({ text }) + '\n');
    const submit = async text => { type(text); await sleep(1000); type('\r'); };
    // The screen drawn since `mark`, escapes and spacing removed (the band and pane are compared as such).
    const raw = () => { try { return fs.readFileSync(path.join(root, 'terminal.log'), 'utf8'); } catch { return ''; } };
    const flat = text => text.replace(/\x1b\[[0-9;?<>=]*[A-Za-z~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[()][A-Z0-9]|\s/g, '');
    const since = mark => flat(raw().slice(mark));
    // The folder trust dialog defaults to "No, exit".
    await until(() => /Itrustthisfolder|←foragents/.test(since(0)), 'the trust dialog or the prompt', 60_000);
    if (since(0).includes('Itrustthisfolder')) { type('\x1b[B'); await sleep(500); type('\r'); }
    await until(() => since(0).includes('←foragents'), 'the prompt', 60_000);
    const task = 'Pane probe task\nPROBE-DELAY 60\nPROBE-ANSWER 300';
    await submit(`Call mcp__agent-bridge__companion_send with cwd="${dirs.work}", companion="codex" and task=${JSON.stringify(task)} (each \\n is a newline). Do not wait. Reply SENT.`);
    await until(() => records('jobs').length, 'the send', 120_000);
    let mark = raw().length;
    await sleep(6000);
    check(since(mark).includes('Paneprobetask') && since(mark).includes('codex·'), 'the band lists the running thread: title and companion');
    mark = raw().length;
    await submit('/companion');
    await sleep(5000);
    check(since(mark).includes('Paneprobetask'), 'the Companions pane lists the thread');
    // The terminal gets only the cells a frame changes, so the job view is known by the transcript child it starts.
    type('1');
    const jobId = records('jobs')[0].jobId;
    const following = () => spawnSync('ps', ['-axo', 'command='], { encoding: 'utf8' }).stdout.split('\n')
      .some(line => line.includes('ui/follow.mjs') && line.includes(jobId));
    check(await until(following, 'the follow child', 15_000).catch(() => false), "the thread's card opens its job and follows the companion's transcript");
    await submit('also mention the word pane');
    await until(() => records('jobs')[0]?.interventions?.some(i => i.from === 'user'), 'the message from the pane', 30_000).catch(() => {});
    const mine = records('jobs')[0]?.interventions?.find(i => i.from === 'user');
    check(mine && mine.state !== 'not_delivered', `a message typed in the pane reached the job (${mine?.mode} ${mine?.state})`);
    await until(() => resultsDone(1), 'the result', 180_000);
  },
});

try {
  await scenarios[scenario]();
} catch (err) { check(false, err.message); }
finally {
  for (const cleanup of cleanups) cleanup();
  model.kill();
  log(`${verdicts.filter(([ok]) => ok).length}/${verdicts.length} passed; root ${root}`);
  process.exit(verdicts.every(([ok]) => ok) && verdicts.length ? 0 : 1);
}
