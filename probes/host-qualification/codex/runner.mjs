import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { definition, hookEvents, prompt, scenarios } from './scenarios.mjs';
import { cleanup, identity, log, owned, readJSON, register, rows, signalOwned, sleep, snapshot, writeJSON } from './common.mjs';
import { analyze } from './analyze.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const quote = s => `'${s.replaceAll("'", "'\\''")}'`; // Shell hooks only; host argv uses spawn without a shell.
const toml = value => {
  if (Array.isArray(value)) return `[${value.map(toml).join(', ')}]`;
  if (value && typeof value === 'object') return `{ ${Object.entries(value).map(([k, v]) => `${JSON.stringify(k)} = ${toml(v)}`).join(', ')} }`;
  return JSON.stringify(value);
};
export function selection(configFile, model, effort) {
  if (model && effort) return { model, effort, source: 'explicit operator selection' };
  const text = fs.readFileSync(configFile, 'utf8');
  const top = text.split(/^\s*\[/m)[0];
  const get = key => {
    const m = top.match(new RegExp(`^\\s*${key}\\s*=\\s*("(?:[^"\\\\]|\\\\.)*"|'[^']*')\\s*(?:#.*)?$`, 'm'));
    return m ? (m[1][0] === '"' ? JSON.parse(m[1]) : m[1].slice(1, -1)) : null;
  };
  if (get('profile')) throw new Error('A profile is selected. Supply --model and --effort from that effective profile; no profile is silently flattened.');
  model ||= get('model'); effort ||= get('model_reasoning_effort');
  if (!model || !effort) throw new Error('Cannot preserve model/effort from top-level config. Supply both --model and --effort.');
  return { model, effort, source: configFile };
}
export function prepare(name, options = {}) {
  const c = definition(name, options.overrides);
  const dir = path.resolve(options.out ?? path.join(here, '.runs', `${new Date().toISOString().replaceAll(':', '-')}-${name}-${process.pid}`));
  let existing = dir;
  while (!fs.existsSync(existing)) existing = path.dirname(existing);
  const canonicalOutput = path.resolve(fs.realpathSync(existing), path.relative(existing, dir));
  for (const forbidden of [path.join(os.homedir(), '.codex'), path.join(os.homedir(), '.claude'), options.sourceHome].filter(Boolean)) {
    const root = fs.existsSync(forbidden) ? fs.realpathSync(forbidden) : path.resolve(forbidden);
    if (canonicalOutput === root || canonicalOutput.startsWith(root + path.sep)) throw new Error('Run directory must be outside the account/config source home');
  }
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  fs.mkdirSync(dir, { mode: 0o700 }); // Refuse reuse, including symlinks or earlier credentials.
  for (const sub of ['codex-home', 'workspace', 'child-workspace', 'other-workspace', 'tmp', 'logs']) fs.mkdirSync(path.join(dir, sub), { mode: 0o700 });
  let workspace = path.resolve(options.workspace ?? path.join(dir, 'workspace'));
  if (!fs.statSync(workspace).isDirectory()) throw new Error('Workspace is not a directory');
  if (name === 'cwd-worktree' || name === 'cwd-symlink') {
    if (!options.workspace) throw new Error(`${name} requires --workspace with an existing worktree`);
    if (execFileSync('git', ['-C', workspace, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' }).trim() !== 'true') throw new Error('Not a worktree');
  }
  if (name === 'cwd-symlink') { fs.symlinkSync(workspace, path.join(dir, 'workspace-link'), 'dir'); workspace = path.join(dir, 'workspace-link'); }
  const paths = { dir, workspace, child: path.resolve(options.childCwd ?? workspace),
    other: path.join(dir, 'other-workspace'), missing: path.join(dir, 'does-not-exist') };
  const home = path.join(dir, 'codex-home');
  const settings = options.selection;
  if (!settings?.model || !settings?.effort) throw new Error('Model and effort are required');
  const hookCommand = `${quote(process.execPath)} ${quote(path.join(here, 'hooks.mjs'))} ${quote(dir)}`;
  const config = {
    model: settings.model, model_reasoning_effort: settings.effort,
    approval_policy: 'never', sandbox_mode: 'read-only', cli_auth_credentials_store: 'file',
    log_dir: path.join(dir, 'logs'), sqlite_home: home, check_for_update_on_startup: false,
    web_search: 'disabled', 'features.multi_agent': true, 'features.hooks': true,
    'features.plugins': false, 'features.apps': false, 'features.memories': false, 'features.shell_tool': false,
    'mcp_servers.fixture.command': process.execPath,
    'mcp_servers.fixture.args': [path.join(here, 'server.mjs'), dir],
    'mcp_servers.fixture.default_tools_approval_mode': 'approve',
    'mcp_servers.fixture.supports_parallel_tool_calls': true,
    'mcp_servers.fixture.tool_timeout_sec': c.tool_timeout_sec,
    'mcp_servers.fixture.env.HOST_QUAL_RESTART_GENERATION': 'initial',
    // Reject repository-local config/hook layers; only the per-run fixture is vetted.
    [`projects.${JSON.stringify(fs.realpathSync(workspace))}.trust_level`]: 'untrusted',
    ...Object.fromEntries(hookEvents.map(event => [`hooks.${event}`, [{ hooks: [
      { type: 'command', command: hookCommand, timeout: event === 'PreToolUse' && c.gate ? c.gate_sec + 5 : 5 },
    ] }]])),
  };
  if (options.autoCompactTokens) config.model_auto_compact_token_limit = options.autoCompactTokens;
  const configText = Object.entries(config).map(([k, v]) => `${k} = ${toml(v)}`).join('\n') + '\n';
  fs.writeFileSync(path.join(dir, 'config.toml'), configText, { mode: 0o600 });
  fs.copyFileSync(path.join(dir, 'config.toml'), path.join(home, 'config.toml'));
  const argv = [options.binary ?? '/opt/homebrew/bin/codex', '--no-daemon'];
  if (c.mode === 'headless') argv.push('exec', '--ignore-user-config', '--skip-git-repo-check', '--json');
  argv.push('--ignore-rules', '--dangerously-bypass-hook-trust', '-C', workspace);
  if (c.mode === 'headless') {
    if (!options.persistent) argv.push('--ephemeral');
    for (const [key, value] of Object.entries(config)) argv.push('-c', `${key}=${toml(value)}`);
    argv.push('-o', path.join(dir, 'final.txt'), '-');
  }
  const manifest = { harness: 'codex-host-qualification-v1', scenario: name, paths,
    selection: settings, source_home: options.sourceHome ?? null, persistent: c.mode === 'TUI' || !!options.persistent,
    prepared_only: true, argv, config_delivery: c.mode === 'TUI' ? 'isolated CODEX_HOME/config.toml' : 'CLI -c overrides; ignore-user-config',
    auth_policy: 'copy auth.json once at launch, file store, remove isolated copy after cleanup; never copy back' };
  writeJSON(path.join(dir, 'manifest.json'), manifest);
  writeJSON(path.join(dir, 'scenario.json'), c);
  writeJSON(path.join(dir, 'command.json'), { argv, model: settings.model, reasoning_effort: settings.effort, live_version: null });
  fs.writeFileSync(path.join(dir, 'prompt.txt'), prompt(c, paths));
  return dir;
}
export async function supervise(dir, commandOverride) {
  identity(process.pid); // Fail before launching anything if this environment cannot inspect owned PIDs.
  const manifest = readJSON(path.join(dir, 'manifest.json'));
  const c = readJSON(path.join(dir, 'scenario.json'));
  const cmd = commandOverride ?? manifest.argv;
  const env = { PATH: process.env.PATH, HOME: os.homedir(), CODEX_HOME: path.join(dir, 'codex-home'),
    TMPDIR: path.join(dir, 'tmp'), PWD: manifest.paths.workspace, TERM: process.env.TERM || 'xterm-256color', LANG: process.env.LANG || 'en_US.UTF-8' };
  let child, ended = null, requestedStop = null, hostRegistered = false, report;
  let injected = false;
  const requestStop = signal => { requestedStop = signal; log(dir, 'supervisor.jsonl', 'runner_signal', { signal }); };
  const onInt = () => requestStop('SIGINT'); const onTerm = () => requestStop('SIGTERM');
  process.on('SIGINT', onInt); process.on('SIGTERM', onTerm);
  const start = performance.now();
  const outFd = fs.openSync(path.join(dir, 'stdout.jsonl'), 'a', 0o600);
  const errFd = fs.openSync(path.join(dir, 'stderr.log'), 'a', 0o600);
  try {
    if (c.mode === 'TUI' && !commandOverride) {
      child = spawn('python3', [path.join(here, 'pty-driver.py'), dir], { cwd: dir, env, stdio: ['inherit', 'inherit', errFd] });
      child.on('error', e => { ended = performance.now(); log(dir, 'supervisor.jsonl', 'host_error', { error: e.message }); });
      if (!child.pid) throw new Error('Could not spawn PTY driver');
      register(dir, child.pid, 'pty-driver');
      console.log(`PTY ready. Use another terminal: node ${quote(path.join(here, 'runner.mjs'))} --action prompt --run-dir ${quote(dir)}`);
    } else {
      child = spawn(cmd[0], cmd.slice(1), { cwd: manifest.paths.workspace, env, detached: true, stdio: ['pipe', outFd, errFd] });
      child.on('error', e => { ended = performance.now(); log(dir, 'supervisor.jsonl', 'host_error', { error: e.message }); });
      if (!child.pid) throw new Error('Could not spawn host');
      register(dir, child.pid, 'host'); hostRegistered = true;
      child.stdin.on('error', e => log(dir, 'supervisor.jsonl', 'stdin_error', { error: e.code }));
      child.stdin.end(fs.readFileSync(path.join(dir, 'prompt.txt')));
      log(dir, 'supervisor.jsonl', 'host_started', { host_pid: child.pid });
    }
    child.on('exit', (code, signal) => { ended = performance.now(); log(dir, 'supervisor.jsonl', 'host_exit', { code, signal, driver: c.mode === 'TUI' }); });
    let nextSample = 0;
    while (!requestedStop) {
      if (!hostRegistered) {
        const pid = readJSON(path.join(dir, 'pty-host.json'))?.pid;
        if (pid) { register(dir, pid, 'host'); hostRegistered = true; fs.writeFileSync(path.join(dir, 'pty-host-registered'), 'go'); log(dir, 'supervisor.jsonl', 'host_started', { host_pid: pid }); }
      }
      if (performance.now() >= nextSample) {
        log(dir, 'samples.jsonl', 'sample', { processes: snapshot(dir) }); nextSample = performance.now() + 500;
      }
      if (c.injection && !injected) {
        const phases = rows(dir, 'mcp.jsonl').filter(r => r.type === 'phase' && r.phase === 'pending_wait');
        const ready = phases.find(r => readJSON(path.join(dir, `${r.execution_id}.json`))?.label === 'owned');
        const witness = !c.witness || phases.some(r => readJSON(path.join(dir, `${r.execution_id}.json`))?.label === 'witness');
        if (ready && readJSON(path.join(dir, `${ready.execution_id}.phase.json`))?.phase === 'pending_wait' && witness && Date.now() - ready.time >= c.after_phase_sec * 1000 &&
            snapshot(dir).filter(p => p.execution_id === ready.execution_id && p.heartbeat).length >= 3) {
          const entry = owned(dir).find(p => c.injection === 'owner' ? p.role === 'host' : p.owned_pid === ready.server_pid);
          if (entry) {
            log(dir, 'supervisor.jsonl', 'host_event', { action: `${c.injection}_${c.signal}`, target_pid: entry.owned_pid,
              execution_id: ready.execution_id, phase: readJSON(path.join(dir, `${ready.execution_id}.phase.json`)), processes: snapshot(dir) });
            signalOwned(dir, entry, c.signal, 'scenario_injection'); injected = true;
          }
        }
      }
      if (ended !== null && performance.now() - ended >= 6100) break;
      if (performance.now() - start >= c.wall_sec * 1000) { log(dir, 'supervisor.jsonl', 'wall_deadline', { wall_sec: c.wall_sec }); break; }
      await sleep(100);
    }
  } finally {
    log(dir, 'supervisor.jsonl', 'observation_end', { elapsed_ms: performance.now() - start, processes: snapshot(dir),
      saved_results: fs.readdirSync(dir).filter(n => n.endsWith('.result.json')) });
    const clean = await cleanup(dir);
    fs.closeSync(outFd); fs.closeSync(errFd);
    // The account credential is never part of the handoff. This also discards isolated refreshes.
    fs.rmSync(path.join(dir, 'codex-home', 'auth.json'), { force: true });
    process.off('SIGINT', onInt); process.off('SIGTERM', onTerm);
    report = analyze(dir);
    if (!clean.all_absent) process.exitCode = 2;
  }
  return report;
}
function validateRun(dir) {
  const m = readJSON(path.join(dir, 'manifest.json'));
  if (m?.harness !== 'codex-host-qualification-v1' || m.paths.dir !== dir) throw new Error('Not a matching qualification run directory');
  return m;
}
function action(dir, name, note) {
  validateRun(dir);
  log(dir, 'supervisor.jsonl', 'operator_action', { action: name, note: note ?? null });
  if (name === 'mark') return;
  if (name === 'release') { fs.writeFileSync(path.join(dir, 'release-gates'), 'operator release\n'); return; }
  if (name === 'restart') {
    const file = path.join(dir, 'codex-home', 'config.toml');
    const text = fs.readFileSync(file, 'utf8').replace(/^mcp_servers\.fixture\.env\.HOST_QUAL_RESTART_GENERATION = .*$/m,
      `mcp_servers.fixture.env.HOST_QUAL_RESTART_GENERATION = "${Date.now()}"`);
    fs.writeFileSync(file, text); fs.writeFileSync(path.join(dir, 'config-after-change.toml'), text);
    console.log('Isolated MCP env setting changed. Observe auto reload, or use the installed TUI reload UI if available. No restart is assumed.'); return;
  }
  const input = { prompt: fs.readFileSync(path.join(dir, 'prompt.txt'), 'utf8').replaceAll('\n', ' ') + '\r',
    compact: '/compact\r', new: '/new\r', stop: '\x1b', quit: '/quit\r',
    followup: 'Use ordinary followup_task on the SAME saved owner target: call fixture catalog label resume-delivered and report retained execution_id. Do not spawn a replacement. Report if the old child is unavailable.\r' }[name];
  if (input === undefined) throw new Error(`Unknown action ${name}`);
  log(dir, 'pty-input.jsonl', 'input', { action: name, text: input });
}
async function main() {
  const { values: v, positionals } = parseArgs({ allowPositionals: true, options: {
    list: { type: 'boolean' }, 'prepare-only': { type: 'boolean' }, persistent: { type: 'boolean' },
    cleanup: { type: 'string' }, action: { type: 'string' }, 'run-dir': { type: 'string' }, note: { type: 'string' },
    out: { type: 'string' }, workspace: { type: 'string' }, 'child-cwd': { type: 'string' }, binary: { type: 'string' },
    'source-home': { type: 'string' }, 'source-config': { type: 'string' }, model: { type: 'string' }, effort: { type: 'string' },
    'wait-sec': { type: 'string' }, 'tool-timeout-sec': { type: 'string' }, 'wall-sec': { type: 'string' },
    'gate-sec': { type: 'string' }, 'after-phase-sec': { type: 'string' }, 'after-spawn-sec': { type: 'string' }, 'auto-compact-tokens': { type: 'string' },
  } });
  if (v.list) { for (const [name, c] of Object.entries(scenarios)) console.log(`${name}\t${c.mode}\t${c.status}\t${c.measure}`); return; }
  if (v.cleanup) { const dir = path.resolve(v.cleanup); validateRun(dir); const result = await cleanup(dir); fs.rmSync(path.join(dir, 'codex-home', 'auth.json'), { force: true }); analyze(dir); if (!result.all_absent) process.exitCode = 2; return; }
  if (v.action) { if (!v['run-dir']) throw new Error('--action needs --run-dir'); action(path.resolve(v['run-dir']), v.action, v.note); return; }
  const name = positionals[0];
  if (!name) throw new Error('Usage: node runner.mjs <scenario> [--prepare-only]; --list lists scenarios');
  const overrides = {};
  for (const key of ['wait-sec', 'tool-timeout-sec', 'wall-sec', 'gate-sec', 'after-phase-sec', 'after-spawn-sec']) if (v[key] !== undefined) {
    const number = Number(v[key]); if (!Number.isFinite(number) || number <= 0) throw new Error(`Invalid --${key}`);
    overrides[key.replaceAll('-', '_')] = number;
  }
  if (overrides.wait_sec > 2100) throw new Error('wait is limited to 2100 seconds');
  if (name.startsWith('long-') && overrides.wait_sec !== undefined && overrides.wait_sec < 1500) throw new Error('Long scenarios require 1500–2100 seconds');
  const sourceHome = path.resolve(v['source-home'] ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'));
  const selected = selection(v['source-config'] ?? path.join(sourceHome, 'config.toml'), v.model, v.effort);
  const dir = prepare(name, { out: v.out, workspace: v.workspace, childCwd: v['child-cwd'], binary: v.binary,
    sourceHome, selection: selected, persistent: v.persistent, overrides,
    autoCompactTokens: v['auto-compact-tokens'] ? Number(v['auto-compact-tokens']) : undefined });
  console.log(dir);
  if (v['prepare-only']) return;
  // No keychain access, whole-home copy, auth logging, symlink, or write-back.
  const authSource = path.join(sourceHome, 'auth.json');
  const authDest = path.join(dir, 'codex-home', 'auth.json');
  try {
    fs.copyFileSync(authSource, authDest, fs.constants.COPYFILE_EXCL); fs.chmodSync(authDest, 0o600);
    const manifest = readJSON(path.join(dir, 'manifest.json')); manifest.prepared_only = false;
    writeJSON(path.join(dir, 'manifest.json'), manifest);
    const command = readJSON(path.join(dir, 'command.json'));
    command.live_version = execFileSync(manifest.argv[0], ['--version'], {
      encoding: 'utf8', timeout: 10000, env: { PATH: process.env.PATH, HOME: os.homedir(), CODEX_HOME: path.join(dir, 'codex-home') },
    }).trim();
    writeJSON(path.join(dir, 'command.json'), command);
    if (command.live_version !== 'codex-cli 0.166.0') throw new Error(`Expected codex-cli 0.166.0; observed ${command.live_version}. Requalify definitions first.`);
    await supervise(dir);
  } finally { fs.rmSync(authDest, { force: true }); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
