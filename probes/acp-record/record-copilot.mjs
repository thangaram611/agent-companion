// Hand-run only. Importing this file performs no IO and starts no runtime.
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { accessSync, constants, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createScrubber } from './scrub.mjs';

export const SCENARIOS = ['turn-command', 'effort', 'cancel', 'signed-out'];
const prompts = {
  'turn-command': 'Run the shell command `echo fixture-ok` and reply with its output.',
  effort: 'Reply with just the word ready.',
  cancel: 'Write a detailed, numbered explanation of every integer from 1 to 10000. Do not summarize or stop early.',
};
const defaultOutput = fileURLToPath(new URL('../../test/fixtures/acp/copilot', import.meta.url));
const byokKeys = ['COPILOT_PROVIDER_BASE_URL', 'COPILOT_PROVIDER_TYPE', 'COPILOT_MODEL', 'COPILOT_OFFLINE'];
const readRows = path => readFileSync(path, 'utf8').trim().split('\n').map(JSON.parse);
const requireThat = (condition, message) => { if (!condition) throw new Error(message); };

// The same real adapter calls are used by recording and fixture acceptance tests.
export async function exerciseScenario(adapter, { scenario, cwd, env, supervisor }) {
  const effort = scenario === 'effort' ? 'low' : undefined;
  await adapter.start({ cwd, env, supervisor, model: env.COPILOT_MODEL, effort });
  let history;
  try { history = await adapter.openHistory({ effort }); }
  catch (err) {
    if (scenario !== 'signed-out' || err.code !== 'AUTH_REQUIRED') throw err;
    return { error: err.code };
  }
  requireThat(scenario !== 'signed-out', 'signed-out: session/new unexpectedly succeeded');
  if (effort) requireThat(history.effectiveEffort === effort, 'effort: low was not confirmed');
  let cancellation;
  if (scenario === 'cancel') {
    const notify = adapter.connection._onNotification.bind(adapter.connection);
    adapter.connection._onNotification = frame => {
      notify(frame);
      if (!cancellation && frame.method === 'session/update' && frame.params?.sessionId === history.historyId) {
        cancellation = adapter.interrupt();
        cancellation.catch(() => {});
      }
    };
  }
  await adapter.deliver({ text: prompts[scenario] });
  const result = await adapter.observe({ onProgress() {} });
  await cancellation;
  requireThat(result.outcome === (scenario === 'cancel' ? 'interrupted' : 'completed'), `${scenario}: unexpected adapter outcome ${result.outcome}`);
  if (scenario === 'effort') requireThat(result.text.trim(), 'effort: missing reply text');
  return { history, result };
}

function validateCapture(scenario, rows, observed) {
  const client = method => rows.filter(row => row.dir === 'client' && row.frame.method === method).map(row => row.frame);
  const answer = request => rows.find(row => row.dir === 'agent' && !row.frame.method && row.frame.id === request?.id)?.frame;
  requireThat(client('initialize').length === 1 && client('session/new').length === 1, `${scenario}: expected one fresh session`);
  if (scenario === 'signed-out') {
    requireThat(observed.error === 'AUTH_REQUIRED' && answer(client('session/new')[0])?.error?.code === -32000
      && client('session/prompt').length === 0, 'signed-out: expected session/new -32000 and AUTH_REQUIRED');
    return;
  }
  requireThat(client('session/prompt').length === 1, `${scenario}: expected one prompt`);
  const stop = answer(client('session/prompt')[0])?.result?.stopReason;
  requireThat(stop === (scenario === 'cancel' ? 'cancelled' : 'end_turn'), `${scenario}: unexpected prompt stop reason`);
  if (scenario === 'cancel') {
    const firstUpdate = rows.findIndex(row => row.dir === 'agent' && row.frame.method === 'session/update');
    const cancel = rows.findIndex(row => row.dir === 'client' && row.frame.method === 'session/cancel');
    requireThat(firstUpdate >= 0 && cancel > firstUpdate && client('session/cancel').length === 1, 'cancel: expected cancellation after a session/update');
  }
  if (scenario === 'effort') {
    const option = answer(client('session/new')[0])?.result?.configOptions?.find(option => option.category === 'thought_level');
    const set = client('session/set_config_option').find(frame => frame.params.configId === option?.id && frame.params.value === 'low');
    requireThat(set && answer(set)?.result?.configOptions?.some(entry => entry.id === option.id && entry.currentValue === 'low'),
      'effort: missing thought_level set/confirmation on the wire');
  }
  if (scenario === 'turn-command') {
    const updates = rows.filter(row => row.dir === 'agent' && row.frame.method === 'session/update').map(row => row.frame.params?.update);
    const command = updates.find(update => update?.sessionUpdate === 'tool_call' && update.kind === 'execute'
      && JSON.stringify(update.rawInput ?? null).includes('echo fixture-ok'));
    requireThat(command && updates.some(update => update?.toolCallId === command.toolCallId && update.status === 'completed'
      && JSON.stringify(update.rawOutput ?? update.content ?? '').includes('fixture-ok'))
      && observed.result.text.includes('fixture-ok'), 'turn-command: missing completed echo fixture-ok tool/output/reply');
  }
}

async function bounded(work, ms, signal) {
  let timer, abort;
  try {
    signal?.throwIfAborted();
    return await Promise.race([work(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('ACP recording timed out')), ms);
      abort = () => reject(new Error('ACP recording interrupted'));
      signal?.addEventListener('abort', abort, { once: true });
    })]);
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

function resolveBinary(env) {
  const binary = env.COPILOT_BIN || 'copilot';
  const candidates = binary.includes('/') ? [resolve(binary)] : env.PATH.split(delimiter).map(dir => resolve(dir, binary));
  const found = candidates.find(file => { try { accessSync(file, constants.X_OK); return true; } catch { return false; } });
  requireThat(found, 'Install Copilot CLI or set COPILOT_BIN to its executable');
  return found;
}

function scrubPaths(pairs) {
  // macOS /var and /private/var aliases can both appear on the wire.
  return pairs.flatMap(([path, placeholder]) => {
    const canonical = realpathSync(path);
    return [...new Set([path, canonical])].map(from => [from, placeholder]);
  });
}

export async function recordCopilot({ selected = SCENARIOS, outputDir = defaultOutput, source = process.env,
  timeoutMs = 180_000, signal, report = console.log } = {}, { check, createSupervisor } = {}) {
  requireThat(selected.length && selected.every(scenario => SCENARIOS.includes(scenario)), `Scenarios: ${SCENARIOS.join(', ')}`);
  const operator = userInfo();
  const forbidden = [...new Set([operator.username, operator.homedir, source.HOME].filter(Boolean))];
  const temp = tmpdir();
  const root = mkdtempSync(join(temp, 'acp-record-'));
  const previousEnv = process.env;
  // BASE_DIR binds on import. Bootstrap before even importing the shared
  // harness, then keep every runtime module on this disposable state root.
  process.env = { PATH: source.PATH, HOME: join(root, 'home'), AGENT_COMPANION_HOME: join(root, 'state'),
    AGENT_RUNTIME_DIR: join(root, 'runtime'), AGENT_COMPANION_HOST: 'codex',
    ...(source.NODE_TEST_CONTEXT ? { NODE_TEST_CONTEXT: source.NODE_TEST_CONTEXT } : {}) };
  const saved = [];
  try {
    const { companionEnv, checkOllama } = await import('../free-backends/run.mjs');
    await (check || checkOllama)({ signal });
    const { AcpAdapter } = await import('../../bridge-server/adapters/acp.mjs');
    const { ProcessSupervisor } = await import('../../bridge-server/controller/process-supervisor.mjs');
    const { getTargetById } = await import('../../lib/target-registry.mjs');
    for (const scenario of selected) {
      signal?.throwIfAborted();
      const scenarioRoot = join(root, scenario);
      const env = companionEnv({ root: scenarioRoot, target: 'copilot', proxyUrl: 'http://127.0.0.1:11434', source });
      if (scenario === 'signed-out') for (const key of byokKeys) delete env[key];
      const cwd = join(scenarioRoot, 'work');
      env.AGENT_RUNTIME_DIR = join(scenarioRoot, 'runtime');
      process.env.TMPDIR = env.TMPDIR; // Includes the adapter's private OTEL scratch directory.
      for (const dir of [cwd, env.HOME, env.TMPDIR, env.CODEX_HOME, env.CLAUDE_CONFIG_DIR, env.COPILOT_HOME,
        env.XDG_CONFIG_HOME, env.XDG_DATA_HOME, env.XDG_STATE_HOME, env.XDG_CACHE_HOME, env.AGENT_COMPANION_HOME, env.AGENT_RUNTIME_DIR]) {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
      }
      const binary = resolveBinary(env);
      let version;
      try { version = execFileSync(binary, ['--version'], { cwd, env, encoding: 'utf8', timeout: 10_000, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'ignore'] }).split(/\r?\n/)[0]; }
      catch { throw new Error('Copilot --version failed'); }
      requireThat(version, 'Copilot --version returned no first line');
      const header = { fixture: 'acp-replay', companion: 'copilot', version, recordedAt: new Date().toISOString(), scenario, model: env.COPILOT_MODEL ?? null };
      const capture = join(scenarioRoot, 'capture.jsonl');
      const paths = scrubPaths([[binary, '/fixture/bin/copilot'], [env.HOME, '/fixture/home'], [cwd, '/fixture/cwd'],
        [env.TMPDIR, '/fixture/tmp'], [root, '/fixture/root'], [temp, '/fixture/tmp']]);
      // The absolute interpreter avoids depending on the operator's node shim.
      env.COPILOT_BIN = join(scenarioRoot, 'tee.mjs');
      writeFileSync(env.COPILOT_BIN, `#!${process.execPath}\nimport ${JSON.stringify(new URL('./tee.mjs', import.meta.url).href)};\n`, { mode: 0o700 });
      env._ACP_RECORD = JSON.stringify({ binary, capture, header, paths, forbidden });
      const supervisor = createSupervisor ? createSupervisor({ scenario, env }) : new ProcessSupervisor();
      const adapter = new AcpAdapter(getTargetById('copilot'), { env, log() {} });
      let observed;
      try {
        observed = await bounded(() => exerciseScenario(adapter, { scenario, cwd, env, supervisor }), timeoutMs, signal);
      } finally {
        const child = supervisor.child;
        const exited = child && child.exitCode === null && child.signalCode === null ? once(child, 'exit') : Promise.resolve();
        await adapter.close();
        try { await bounded(() => exited, 3000); }
        finally {
          const stopped = await supervisor.terminate({ graceMs: 100 });
          requireThat(stopped.gone, `${scenario}: process cleanup unverified`);
        }
      }
      requireThat(supervisor.child?.exitCode === 0, `${scenario}: tee failed; no fixture saved`);
      const [capturedHeader, ...rows] = readRows(capture);
      validateCapture(scenario, rows, observed);
      // Recheck the complete capture (including the provenance header) before
      // publishing. A refused re-record leaves the previous fixture untouched.
      createScrubber({ forbidden })([capturedHeader, ...rows]);
      mkdirSync(outputDir, { recursive: true });
      const destination = join(outputDir, `${scenario}.jsonl`);
      const staging = join(outputDir, `.${scenario}.${process.pid}.tmp`);
      try {
        writeFileSync(staging, readFileSync(capture), { mode: 0o600, flag: 'wx' });
        renameSync(staging, destination);
      } finally { rmSync(staging, { force: true }); }
      saved.push({ path: destination, ...observed });
      report(`Recorded ${scenario}`);
    }
    return saved;
  } finally {
    process.env = previousEnv;
    rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    if (process.argv.includes('--help')) console.log(`node probes/acp-record/record-copilot.mjs [${SCENARIOS.join(' ')}]\nOmit scenarios to record all four. Requires local Ollama; see probes/README.md.`);
    else await recordCopilot({ selected: process.argv.length > 2 ? process.argv.slice(2) : SCENARIOS, signal: abort.signal });
  } catch (err) {
    // Native exceptions can contain paths or credentials. Only scrubbed errors
    // reach the terminal; raw wire/error objects are never serialized to files.
    try { console.error(createScrubber({ forbidden: [userInfo().username, userInfo().homedir] })(err.message)); }
    catch { console.error('ACP recording failed; no fixture saved for the failing scenario.'); }
    process.exitCode = 1;
  } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
}
