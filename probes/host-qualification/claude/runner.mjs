import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ROOT, inside, log, rows, readJSON, writeJSON, sleep, recordPID, pidRecords,
  signalPID, cleanup, snapshot, phaseAt, processInfo } from './common.mjs';
import { scenarios, configuration, prompt, settings } from './scenarios.mjs';
import { analyze } from './analyze.mjs';

const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
function envOverrides(dir, authMode) {
  if (!['inherit', 'isolated-config'].includes(authMode)) throw Error(`Unknown auth mode ${authMode}`);
  return { ...(authMode === 'isolated-config' ? { CLAUDE_CONFIG_DIR: dir + '/host-home' } : {}),
    DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
}
export function hostEnv(dir, authMode = 'inherit', source = process.env) {
  // Do not inherit a running host's IPC, plugins, model overrides or timeout knobs.
  // In particular, discard any ambient CLAUDE_CONFIG_DIR in inherited-auth mode.
  if (authMode === 'isolated-config' && !source.ANTHROPIC_API_KEY && !source.CLAUDE_CODE_OAUTH_TOKEN)
    throw Error('Isolated config requires ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN; no login is automated');
  const allowed = ['PATH', 'HOME', 'USER', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM',
    'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY',
    'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'];
  const env = Object.fromEntries(allowed.filter(k => source[k] !== undefined).map(k => [k, source[k]]));
  return { ...env, ...envOverrides(dir, authMode) };
}
function runPath(value) {
  const dir = path.resolve(value);
  const base = path.join(ROOT, 'runs');
  if (!inside(base, dir) || dir === base) throw Error(`Run directories must be below ${base}`);
  // Reject existing symlink ancestors that would escape the allowed tree.
  let parent = dir;
  while (!fs.existsSync(parent)) parent = path.dirname(parent);
  if (!inside(ROOT, fs.realpathSync(parent))) throw Error('Run directory escapes probe through a symlink');
  return dir;
}
export function prepare(name, options = {}) {
  const dir = runPath(options.dir ?? path.join(ROOT, 'runs', `${name}-${new Date().toISOString().replaceAll(':', '-')}`));
  if (fs.existsSync(dir)) throw Error('Use a fresh run directory; evidence is never overwritten');
  const config = configuration(name, options.overrides);
  const authMode = options.isolatedConfig ? 'isolated-config' : 'inherit';
  const persistence = authMode === 'isolated-config' || config.mode === 'TUI';
  if (config.action === 'long' && (config.waitSec < 1500 || config.waitSec > 2100)) throw Error('Long waits must be 1500–2100 seconds');
  if (config.action === 'long' && !options.overrides?.wallSec) config.wallSec = config.waitSec + 180;
  config.workSec = options.overrides?.workSec ?? config.wallSec + 120;
  for (const value of [config.wallSec, config.budget, config.waitSec, config.serverTimeoutMs, config.progressSec])
    if (!Number.isFinite(value) || value <= 0) throw Error('Durations and budget must be finite and positive');
  for (const sub of ['', 'host-home/agents', 'workspace', 'child-workspace', 'executions'])
    fs.mkdirSync(path.join(dir, sub), { recursive: true, mode: 0o700 });
  fs.symlinkSync(path.join(dir, 'child-workspace'), path.join(dir, 'child-link'), 'dir');
  writeJSON(dir + '/scenario.json', config);
  const hookCommand = 'exec ' + [process.execPath, path.join(ROOT, 'hook.mjs'), dir].map(quote).join(' ');
  writeJSON(dir + '/settings.json', settings(dir, hookCommand, config));
  const channels = ['fixture', 'observer', ...(config.independent ? ['fixture_control'] : [])];
  writeJSON(dir + '/mcp.json', { mcpServers: Object.fromEntries(channels.map(channel => [channel, {
    type: 'stdio', command: process.execPath, args: [path.join(ROOT, 'fixture.mjs'), dir, channel],
    timeout: config.serverTimeoutMs, env: { HOST_QUALIFICATION_GENERATION: '0' },
  }])) });
  const agents = {};
  for (const channel of channels.filter(c => c !== 'observer')) {
    const name = channel === 'fixture' ? 'fixture-native' : 'fixture-control';
    agents[name] = { description: 'Disposable native child for host qualification; local fake tools only.',
      prompt: 'Use only the named fixture MCP tools. Preserve executionId and errors. Report actual observations briefly. Your thread is injected by the host hook. Never invent it or retry send. Follow native messages; no provider model is called.',
      tools: ['catalog', 'send', 'wait', 'stop'].map(tool => `mcp__${channel}__${tool}`),
      model: 'inherit', maxTurns: 16, mcpServers: [channel] };
    fs.writeFileSync(`${dir}/host-home/agents/${name}.md`, `---\nname: ${name}\ndescription: ${agents[name].description}\nmodel: inherit\nmaxTurns: 16\ntools: ${JSON.stringify(agents[name].tools)}\nmcpServers: [${channel}]\n---\n${agents[name].prompt}\n`);
  }
  writeJSON(dir + '/agents.json', agents);
  const text = prompt(config, dir);
  fs.writeFileSync(dir + '/prompt.txt', text);
  const args = ['--setting-sources', '', '--settings', dir + '/settings.json', '--strict-mcp-config',
    '--mcp-config', dir + '/mcp.json', '--agents', config.mode === 'TUI' ? JSON.stringify(agents) : dir + '/agents.json',
    '--tools', 'Agent,SendMessage,TaskStop,TaskOutput', '--allowedTools', 'Agent(fixture-native)',
    'Agent(fixture-control)', 'SendMessage', 'TaskStop', 'TaskOutput', 'mcp__fixture__*',
    'mcp__fixture_control__*', 'mcp__observer__*', '--model', config.model, '--debug-file', dir + '/debug.log'];
  if (config.mode === 'headless') args.unshift('-p', '--verbose', '--output-format', 'stream-json',
    '--include-hook-events', '--forward-subagent-text', '--max-budget-usd', String(config.budget), '--max-turns', '24');
  if (!persistence) args.unshift('--no-session-persistence');
  args.push('--', text);
  writeJSON(dir + '/command.json', { executable: options.bin ?? 'claude', args, cwd: dir + '/workspace',
    expectedVersion: options.version ?? '2.1.318', authMode, envOverrides: envOverrides(dir, authMode),
    credentials: 'Host-managed authentication; no credential files read or copied', persistence });
  return dir;
}

export async function execute(dir) {
  dir = runPath(dir);
  const config = readJSON(dir + '/scenario.json');
  const command = readJSON(dir + '/command.json');
  if (fs.existsSync(dir + '/host.json')) throw Error('This run has already started; use a fresh directory');
  // Older unstarted preparations (e.g. smoke-review) adopt the new default too.
  command.authMode ??= 'inherit';
  command.envOverrides = envOverrides(dir, command.authMode);
  command.persistence = command.authMode === 'isolated-config' || config.mode === 'TUI';
  command.credentials = 'Host-managed authentication; no credential files read or copied';
  if (!command.persistence && !command.args.includes('--no-session-persistence')) command.args.unshift('--no-session-persistence');
  writeJSON(dir + '/command.json', command);
  if (!processInfo(process.pid).birth) throw Error('Process inspection (ps) is unavailable; refusing to launch a host without verifiable PID cleanup');
  const env = hostEnv(dir, command.authMode);
  // Only executed by the operator (or the offline fake host). Preparation never invokes Claude.
  const preflight = flag => execFileSync(command.executable, [flag], { env, cwd: command.cwd,
    encoding: 'utf8', timeout: 10000, maxBuffer: 2 * 1024 * 1024 });
  const version = preflight('--version');
  const help = preflight('--help');
  fs.writeFileSync(dir + '/host-version.txt', version);
  fs.writeFileSync(dir + '/host-help.txt', help);
  if (!version.includes(command.expectedVersion)) throw Error(`Host version differs from expected ${command.expectedVersion}; review before preparing a new run`);
  const needed = ['--setting-sources', '--strict-mcp-config', '--agents', '--settings', '--tools',
    ...(config.mode === 'headless' ? ['--max-budget-usd'] : []),
    ...(!command.persistence ? ['--no-session-persistence'] : [])];
  for (const flag of needed) if (!help.includes(flag)) throw Error(`Host help lacks ${flag}; do not silently drop isolation or measurement flags`);
  let bin = command.executable;
  let args = command.args;
  if (config.mode === 'TUI') {
    if (!process.stdin.isTTY) throw Error('TUI scenarios require an operator terminal');
    execFileSync('python3', ['-m', 'venv', dir + '/venv'], { timeout: 30000 });
    bin = dir + '/venv/bin/python';
    args = [path.join(ROOT, 'pty-driver.py'), dir];
  }
  let interrupted = null;
  const onSignal = signal => { interrupted = signal; };
  const onINT = () => onSignal('SIGINT');
  const onTERM = () => onSignal('SIGTERM');
  process.on('SIGINT', onINT); process.on('SIGTERM', onTERM);
  let child;
  let exit = null;
  let abortAt = null;
  let eventSent = false;
  let hostRecorded = false;
  const start = performance.now();
  const out = fs.createWriteStream(dir + (config.mode === 'TUI' ? '/terminal.log' : '/stdout.jsonl'));
  const err = fs.createWriteStream(dir + '/stderr.log');
  try {
    child = spawn(bin, args, { env, cwd: command.cwd,
      stdio: [config.mode === 'TUI' ? 'inherit' : 'ignore', 'pipe', 'pipe'] });
    child.stdout.pipe(out); child.stderr.pipe(err);
    if (config.mode === 'TUI') { child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr); }
    child.on('error', error => { exit = { t: Date.now(), error: error.message, code: null }; });
    child.on('exit', (code, signal) => { exit = { t: Date.now(), code, signal }; });
    if (child.pid) recordPID(dir, child.pid, config.mode === 'TUI' ? 'pty-driver' : 'host');
    if (config.mode === 'headless' && child.pid) {
      writeJSON(dir + '/host.json', { pid: child.pid, started: Date.now() }); hostRecorded = true;
    }
    let nextSample = 0;
    while (!exit) {
      const elapsed = performance.now() - start;
      const host = readJSON(dir + '/host.json');
      if (host && !hostRecorded) { recordPID(dir, host.pid, 'host'); hostRecorded = true; }
      if (elapsed >= nextSample) { snapshot(dir, 'periodic'); nextSample = elapsed + 1000; }
      const events = rows(dir, 'events.jsonl');
      const hooks = rows(dir, 'hooks.jsonl');
      const phase = phaseAt(events, hooks, Date.now());
      const control = phaseAt(events, hooks, Date.now(), null, 'fixture_control');
      if (!eventSent && ['parent-kill', 'fixture-kill'].includes(config.action) && phase.phase === 'pending-wait' &&
          (!config.independent || control.phase === 'pending-wait') && Date.now() - phase.since >= config.eventDelaySec * 1000) {
        const role = config.action === 'parent-kill' ? 'host' : 'server';
        const target = pidRecords(dir).find(p => p.role === role && (role === 'host' || p.channel === 'fixture'));
        if (target) {
          log(dir, 'controller.jsonl', 'host_event', { name: config.name, target: target.target, ...phase });
          signalPID(dir, target, config.signal ?? 'SIGKILL', config.name);
          eventSent = true;
        }
      }
      if ((elapsed >= config.wallSec * 1000 || interrupted) && abortAt === null) {
        log(dir, 'controller.jsonl', 'host_event', { name: interrupted ? 'runner-interrupted' : 'wall-timeout', ...phase });
        abortAt = elapsed;
      }
      if (abortAt !== null) {
        const signal = elapsed - abortAt < 3000 ? 'SIGTERM' : 'SIGKILL';
        for (const p of pidRecords(dir).filter(p => ['host', 'pty-driver'].includes(p.role))) signalPID(dir, p, signal, 'wall-or-interrupt');
        if (elapsed - abortAt > 8000) { exit = { t: Date.now(), error: 'host-exit-unconfirmed' }; break; }
      }
      await sleep(100);
    }
    writeJSON(dir + '/exit.json', exit);
    log(dir, 'controller.jsonl', 'host_exit', exit);
    // The host is gone, but detached descendants may not be. Preserve a full +5 s observation.
    for (let i = 0; i < 7; i++) { snapshot(dir, 'post-host-exit'); await sleep(1000); }
  } finally {
    if (config.mode === 'TUI' && !hostRecorded) {
      const host = readJSON(dir + '/host.json');
      if (host) recordPID(dir, host.pid, 'host');
    }
    snapshot(dir, 'measurement-end');
    const cleaned = await cleanup(dir);
    out.end(); err.end();
    process.removeListener('SIGINT', onINT); process.removeListener('SIGTERM', onTERM);
    writeJSON(dir + '/analysis.json', analyze(dir));
    if (!cleaned.allGone) process.exitCode = 2;
    else if (abortAt !== null) process.exitCode = 124;
    else if (exit?.error || (exit?.code && config.action !== 'parent-kill')) process.exitCode = 1;
  }
  console.log(JSON.stringify({ runDir: dir, exit, analysis: dir + '/analysis.json' }));
}

export function action(dir, name, detail = '') {
  dir = runPath(dir);
  const phase = phaseAt(rows(dir, 'events.jsonl'), rows(dir, 'hooks.jsonl'), Date.now());
  log(dir, 'controller.jsonl', 'operator_event', { name, detail, ...phase });
  if (name === 'settings-restart') {
    const config = readJSON(dir + '/mcp.json');
    config.mcpServers.fixture.env.HOST_QUALIFICATION_GENERATION = String(Date.now());
    writeJSON(dir + '/mcp.json', config);
    const settings = readJSON(dir + '/settings.json');
    settings.env = { HOST_QUALIFICATION_GENERATION: config.mcpServers.fixture.env.HOST_QUALIFICATION_GENERATION };
    writeJSON(dir + '/settings.json', settings);
  } else if (['clear', 'compact', 'native-close', 'resume'].includes(name)) {
    const text = { clear: '/clear', compact: '/compact', 'native-close': '/exit',
      resume: `Attempt SendMessage to the SAME original fixture-native child ${detail || '(use its recorded ID)'}: call catalog with marker=resume-confirmed and report retained executionId. Do not spawn a replacement.` }[name];
    log(dir, 'tui-input.jsonl', 'input', { text: text + '\r' });
  } else if (['pause-fixture', 'continue-fixture'].includes(name)) {
    const p = pidRecords(dir).filter(p => p.role === 'server' && p.channel === 'fixture').at(-1);
    if (!p) throw Error('No recorded fixture server');
    signalPID(dir, p, name === 'pause-fixture' ? 'SIGSTOP' : 'SIGCONT', name);
  }
  console.log(JSON.stringify({ action: name, runDir: dir, phase }));
}

async function main() {
  const [name, ...args] = process.argv.slice(2);
  if (name === 'list') { console.table(Object.entries(scenarios).map(([name, s]) => ({ name, mode: s.mode, measure: s.measure }))); return; }
  if (name === 'cleanup') { const result = await cleanup(runPath(args[0])); console.log(JSON.stringify(result)); if (!result.allGone) process.exitCode = 2; return; }
  if (name === 'execute') return execute(args[0]);
  if (name === 'action') return action(args[0], args[1], args.slice(2).join(' '));
  const options = { overrides: {} };
  let live = false;
  const numeric = { '--wait-sec': 'waitSec', '--wall-sec': 'wallSec', '--budget-usd': 'budget',
    '--server-timeout-ms': 'serverTimeoutMs', '--after-spawn-sec': 'afterSpawnSec', '--event-delay-sec': 'eventDelaySec',
    '--gap-sec': 'gapGateSec', '--startup-sec': 'startupGateSec' };
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === '--execute') live = true;
    else if (key === '--isolated-config') options.isolatedConfig = true;
    else if (key === '--prepare') continue;
    else if (numeric[key]) options.overrides[numeric[key]] = Number(args[++i]);
    else if (key === '--run-dir') options.dir = args[++i];
    else if (key === '--claude-bin') options.bin = args[++i];
    else if (key === '--expected-version') options.version = args[++i];
    else if (key === '--model') options.overrides.model = args[++i];
    else throw Error(`Unknown option ${key}`);
  }
  const dir = prepare(name, options);
  console.log(JSON.stringify({ prepared: dir, mode: readJSON(dir + '/scenario.json').mode }));
  if (live) await execute(dir);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => {
  console.error(error.message); process.exitCode = 1;
});
