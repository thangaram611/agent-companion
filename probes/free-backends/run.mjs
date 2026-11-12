// Operator-only live harness. Tests inject the network, bridge and probe seams.
import { accessSync, constants, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startBridge, record } from '../smoke/bridge-client.mjs';
import { runEffortProbe } from '../smoke/effort.mjs';
import { startProxy } from './proxy.mjs';

export const repo = fileURLToPath(new URL('../..', import.meta.url));
export const targets = ['codex', 'claude', 'copilot', 'opencode'];
const localModel = 'gpt-oss:20b';
const instructions = 'brew install ollama\nOLLAMA_CONTEXT_LENGTH=32768 ollama serve\nollama pull gpt-oss:20b';

export function companionEnv({ root, target, proxyUrl, source = process.env }) {
  if (!targets.includes(target)) throw new Error(`Unsupported free-backend target: ${target}`);
  const home = join(root, target, 'home');
  // Allowlist, never inherit provider credentials, instruction/config overrides,
  // proxy variables, NODE_OPTIONS or the operator's installed plugin settings.
  const env = { PATH: source.PATH || '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin', HOME: home,
    LANG: 'en_US.UTF-8', TMPDIR: join(root, target, 'tmp'),
    CODEX_HOME: join(home, '.codex'), CLAUDE_CONFIG_DIR: join(home, '.claude'), COPILOT_HOME: join(home, '.copilot'),
    XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local/share'),
    XDG_STATE_HOME: join(home, '.local/state'), XDG_CACHE_HOME: join(home, '.cache'),
    AGENT_COMPANION_HOME: join(root, target, 'bridge'), AGENT_COMPANION_HOST: 'codex' };
  if (source.NODE_TEST_CONTEXT) env.NODE_TEST_CONTEXT = source.NODE_TEST_CONTEXT;
  const binary = `${target.toUpperCase()}_BIN`;
  if (source[binary]) env[binary] = source[binary].includes('/') ? resolve(source[binary]) : source[binary];
  if (target === 'claude') Object.assign(env, { ANTHROPIC_BASE_URL: proxyUrl, ANTHROPIC_AUTH_TOKEN: 'ollama' });
  if (target === 'copilot') Object.assign(env, { COPILOT_PROVIDER_BASE_URL: `${proxyUrl}/v1`, COPILOT_PROVIDER_TYPE: 'openai',
    COPILOT_MODEL: localModel, COPILOT_OFFLINE: 'true' });
  if (target === 'opencode') env.OPENCODE_DB = join(env.XDG_DATA_HOME, 'opencode', 'opencode.db');
  return env;
}

export async function checkOllama({ signal, fetchImpl = fetch } = {}) {
  let response;
  try {
    response = await fetchImpl('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.any([AbortSignal.timeout(5000), ...(signal ? [signal] : [])]) });
    if (!response.ok) throw new Error('unreachable');
  } catch (err) {
    signal?.throwIfAborted();
    throw new Error(`Ollama must already be running. Start it yourself (Homebrew):\n${instructions}`, { cause: err });
  }
  const tags = await response.json();
  if (!tags.models?.some(model => (model.name ?? model.model) === localModel)) throw new Error(`Pull the local model first: ollama pull ${localModel}`);
}

function prepare({ root, target, env, proxyUrl }) {
  const cwd = join(root, target, 'work');
  for (const dir of [cwd, env.HOME, env.TMPDIR, env.CODEX_HOME, env.CLAUDE_CONFIG_DIR, env.COPILOT_HOME,
    env.XDG_CONFIG_HOME, env.XDG_DATA_HOME, env.XDG_STATE_HOME, env.XDG_CACHE_HOME, env.AGENT_COMPANION_HOME]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (target === 'codex') writeFileSync(join(env.CODEX_HOME, 'config.toml'),
    `model = "${localModel}"\nmodel_provider = "ollama-proxy"\n\n[model_providers.ollama-proxy]\nname = "Local Ollama probe"\nbase_url = "${proxyUrl}/v1"\nwire_api = "responses"\n`, { mode: 0o600 });
  if (target === 'opencode') mkdirSync(join(env.XDG_DATA_HOME, 'opencode'), { recursive: true, mode: 0o700 });
  const binary = env[`${target.toUpperCase()}_BIN`] || target;
  const candidates = binary.includes('/') ? [binary] : env.PATH.split(delimiter).map(dir => join(dir, binary));
  if (!candidates.some(file => { try { accessSync(file, constants.X_OK); return true; } catch { return false; } })) throw new Error(`Install ${target} before running its probe (Homebrew); executable unavailable`);
  return cwd;
}

export async function runFreeBackends({ selected = targets, source = process.env, signal, report = console.log } = {},
  { check = checkOllama, proxyStart = startProxy, bridgeStart = startBridge, probe = runEffortProbe } = {}) {
  if (!selected.length || selected.some(target => !targets.includes(target))) throw new Error(`Usage: node probes/free-backends/run.mjs [${targets.join('|')} ...]`);
  await check({ signal });
  signal?.throwIfAborted();
  const root = mkdtempSync(join(tmpdir(), 'agentco-free-'));
  report(`Artifacts: ${root}`);
  report('Requires Ollama context >= 32768; the active context setting is not detectable by this harness.');
  const logFile = join(root, 'wire.jsonl');
  writeFileSync(logFile, '', { mode: 0o600 });
  const proxy = await proxyStart({ logFile });
  try {
    for (const target of selected) {
      signal?.throwIfAborted();
      const env = companionEnv({ root, target, proxyUrl: proxy.url, source });
      const cwd = prepare({ root, target, env, proxyUrl: proxy.url });
      const session = `free-${target}-${Date.now()}`;
      const bridge = await bridgeStart(session, { env, repo, signal });
      try {
        await probe({ bridge, target, cwd, owner: `${session}-child`, report,
          model: target === 'copilot' ? undefined : target === 'opencode' ? 'opencode/flint-40b-free' : localModel,
          backendEffort: target === 'codex' ? 'low' : undefined,
          readWire: target === 'opencode' ? undefined : () => readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map(JSON.parse),
          record: (kind, id) => record(kind, id, env.AGENT_COMPANION_HOME) });
      } finally { await bridge.stop(); }
    }
    return root;
  } finally { await proxy.stop(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const abort = new AbortController();
  const handlers = ['SIGINT', 'SIGTERM', 'SIGHUP'].map((name, i) => {
    const handler = () => { process.exitCode = [130, 143, 129][i]; abort.abort(new Error(`Stopped by ${name}`)); };
    process.on(name, handler); return [name, handler];
  });
  try { await runFreeBackends({ selected: process.argv.length > 2 ? process.argv.slice(2) : targets, signal: abort.signal }); }
  catch (err) { console.error(err.message); process.exitCode ||= 1; }
  finally { for (const [name, handler] of handlers) process.removeListener(name, handler); }
}
