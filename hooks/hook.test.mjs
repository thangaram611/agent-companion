import '../test/sandbox-home.mjs';
import { tools, createBridgeController } from '../bridge-server/tools.mjs';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { setupController } from '../test/controller/helpers.mjs';
import { callTool } from '../test/tool-call.mjs';
import { HOSTS } from '../lib/hosts/index.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const HERE = import.meta.dirname;

const manifest = host => JSON.parse(readFileSync(join(HERE, host === 'codex' ? 'hooks-codex.json' : 'hooks.json'))).hooks;
for (const host of ['claude', 'codex']) test(`${host} runs manifest commands from a plugin path with spaces`, () => {
  const root = mkdtempSync(join(process.env.HOME, 'plugin root '));
  mkdirSync(join(root, 'hooks'));
  for (const file of ['hook.sh', 'install-deps.sh']) {
    writeFileSync(join(root, 'hooks', file), `echo "${file} \${1:-} \${AGENT_COMPANION_HOST:-claude}"`);
  }
  const hooks = manifest(host);
  const events = { PostToolUse: ['hook.sh post-tool'], UserPromptSubmit: ['hook.sh prompt'],
    SessionStart: ['install-deps.sh ', 'hook.sh session-start'] };
  if (host === 'claude') events.PreToolUse = ['hook.sh pre-tool'];
  const env = { ...process.env, CLAUDE_PLUGIN_ROOT: root, PLUGIN_ROOT: root, AGENT_COMPANION_HOST: 'claude' };
  for (const [event, expected] of Object.entries(events)) {
    const commands = hooks[event].flatMap(group => group.hooks);
    assert.deepEqual(commands.map(h => execFileSync('/bin/bash', ['-c', h.command], { env, encoding: 'utf8' }).trimEnd()),
      expected.map(name => name + ' ' + host));
  }
});

test('Claude stamps the host lead on every protected tool and preserves the requested thread', async () => {
  const [group] = manifest('claude').PreToolUse;
  assert.equal(group.hooks[0].onFailure, 'block');
  const matcher = new RegExp(group.matcher);
  for (const prefix of ['', 'mcp__agent-bridge__', HOSTS.claude.toolPrefix]) {
    for (const { name, action } of tools) assert.equal(matcher.test(prefix + name), action !== 'catalog');
    assert.ok(!matcher.test(prefix + 'companion_send_extra'));
  }
  for (const agent of [null, 'native-child']) {
    const input = { thread: 'th-123', task: 'review', lead: { session: 'invented' } };
    const result = await runHook('pre-tool', { session_id: 'native-session', agent_id: agent ?? undefined, tool_input: input });
    assert.deepEqual(result.updatedInput, { ...input, lead: { session: 'native-session', agent } });
  }
});

const runHook = (event, payload, env) => {
  const run = promisify(execFile)('/bin/bash', [join(HERE, 'hook.sh'), event], {
    env: { ...process.env, ...env }, encoding: 'utf8', timeout: 10000,
  });
  run.child.stdin.end(JSON.stringify(payload));
  return run.then(({ stdout }) => stdout ? JSON.parse(stdout).hookSpecificOutput : null);
};

test('empty news path starts no process; an unavailable identity rewrite denies the call', async () => {
  const bin = mkdtempSync(join(process.env.HOME, 'bin-'));
  const trace = join(bin, 'node-calls');
  writeFileSync(join(bin, 'node'), `#!/bin/sh\necho called >> "${trace}"\nexit 1\n`, { mode: 0o700 });
  for (const event of ['post-tool', 'prompt']) assert.equal(await runHook(event, { session_id: 'idle' }, { PATH: bin }), null);
  assert.equal(existsSync(trace), false);
  assert.equal((await runHook('pre-tool', { tool_input: { lead: { session: 'fake' } } })).permissionDecision, 'deny');
});

test('session start removes only sentinel-marked legacy agent files on each host', async () => {
  for (const host of Object.values(HOSTS).filter(h => h.oldAgentFile)) {
    const env = { AGENT_COMPANION_HOST: host.id, CODEX_HOME: join(process.env.HOME, 'custom codex') };
    const dir = join(host.configDir({ ...process.env, ...env }), 'agents');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'agent-companion.' + (host.id === 'codex' ? 'toml' : 'md'));
    for (const [body, keep] of [['user file', true], ['---\n# AUTO-INSTALLED by agent-companion plugin (old)\n', false]]) {
      writeFileSync(file, body);
      await runHook('session-start', { session_id: 'new' }, env);
      assert.equal(existsSync(file), keep);
    }
  }
});

// Warm the real Node entry's imports before releasing stdin. Otherwise the
// tool can finish during shell startup and the empty-marker fast path wins.
async function readyHook(env) {
  const imports = ['../bridge-server/delivery.mjs', '../bridge-server/controller/records.mjs']
    .map(path => `import ${JSON.stringify(new URL(path, import.meta.url).href)};`).join('\n');
  const preload = 'data:text/javascript,' + encodeURIComponent(imports + 'process.stderr.write("ready");');
  const run = promisify(execFile)(process.execPath, ['--import', preload, join(HERE, 'hook.mjs'), 'post-tool'], {
    env: { ...process.env, ...env }, encoding: 'utf8', timeout: 10000,
  });
  await Promise.race([once(run.child.stderr, 'data'), run]);
  return payload => {
    run.child.stdin.end(JSON.stringify(payload));
    return run.then(({ stdout }) => stdout ? JSON.parse(stdout).hookSpecificOutput : null);
  };
}

test('racing hook and terminal tool calls deliver once and preserve sibling news', async () => {
  const h = setupController({ companion: 'opencode', createController: createBridgeController });
  const env = { AGENT_COMPANION_HOME: h.dir, AGENT_RUNTIME_DIR: process.env.AGENT_RUNTIME_DIR };
  const lead = { session: 'race-session', agent: 'native-child' };
  const payload = { session_id: lead.session, agent_id: lead.agent };
  const call = (action, args, options) => callTool({ action, lead, ...args }, { controller: h.controller, ...options });
  const marker = join(env.AGENT_RUNTIME_DIR, 'news', lead.session);
  for (let i = 0; i < 16; i++) {
    const { thread, job_id } = await call('send', { cwd: h.dir, task: 'race', companion: 'opencode' });
    const answer = 'unescaped answer\n' + job_id;
    await h.finish(job_id, { outcome: 'completed', text: answer }, h.adapters.at(-1));
    const path = h.records.path('results', job_id) + '.delivery';
    if (i === 0) {
      assert.equal(statSync(marker).size, 0);
      assert.equal(statSync(marker).mode & 0o777, 0o600);
      assert.equal(statSync(dirname(marker)).mode & 0o777, 0o700);
      assert.equal(await runHook('prompt', { session_id: lead.session }, env), null);
      await call('wait', { thread }, { signal: AbortSignal.abort() });
      assert.equal(existsSync(path), false);
    }
    const hook = i === 0 ? runHook('post-tool', payload, env) : (await readyHook(env))(payload);
    if (i === 0) await hook; // Also exercise the stub with news and hook-first replay.
    const [injection, tool] = await Promise.all([hook, call('wait', { thread })]);
    assert.equal(Number(injection?.additionalContext.includes(answer) ?? false) + Number(tool.content === answer), 1);
    assert.equal(readFileSync(path, 'utf8').trim(), injection ? 'hook' : 'tool');
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(statSync(dirname(path)).mode & 0o777, 0o700);
    assert.equal(existsSync(marker), false);
    assert.deepEqual(await call('wait', { thread }), tool);
    if (injection) {
      assert.equal(injection.hookEventName, 'PostToolUse');
      assert.equal(tool.meta.delivered_by, 'hook');
    }
  }
});
