#!/usr/bin/env node
// install-antigravity-acp.mjs — install (or upgrade) Google's Antigravity ACP
// server from the ACP registry, and optionally sign it in.
//
//   node scripts/install-antigravity-acp.mjs            install/upgrade to the registry's version
//   node scripts/install-antigravity-acp.mjs --login    …and drive the oauth-personal login (browser)
//   node scripts/install-antigravity-acp.mjs --check    print installed and registry versions; exit 1 if behind
//
// Why a script: `agy` (the Homebrew cask) has no ACP mode. The binary Google
// ships for ACP clients is `agy_acp_server.par`, published to the ACP registry
// as `antigravity-acp` for Zed, JetBrains and Xcode — no brew formula, no npm
// package, a 316 MB zip per platform. This does what those editors' registry
// installers do: read the registry, fetch the platform archive, verify the
// Developer ID signature on macOS, unpack under a versioned directory and
// point `current` at it. It writes nothing outside that directory; the login
// writes to the server's own home (`~/.gemini/antigravity-acp/`, by the
// server itself).
//
// Dependency-free by design, like every script in scripts/: global fetch for
// the registry document, child_process for `curl`, `unzip` and `codesign`.

import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { antigravityAcpPaths } from '../lib/target-registry.mjs';

export const REGISTRY_URL = 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json';
export const AGENT_ID = 'antigravity-acp';
// The Developer ID the macOS binaries were signed with (measured 2026-09-11 on
// 1.1.1: `Authority=Developer ID Application: Google LLC (EQHXZ8M8AV)`).
export const EXPECTED_AUTHORITY = 'Developer ID Application: Google LLC (EQHXZ8M8AV)';

// The registry keys its binaries by `<os>-<arch>` in Rust's vocabulary; the
// darwin entry is aarch64 only (no Intel Mac build on 2026-09-11).
const PLATFORM_KEYS = {
  'darwin-arm64': 'darwin-aarch64',
  'linux-x64': 'linux-x86_64',
  'linux-arm64': 'linux-aarch64',
};

// Pure: pick this platform's archive out of the registry document.
export function selectDistribution(registry, platform = process.platform, arch = process.arch) {
  const agents = Array.isArray(registry?.agents) ? registry.agents : [];
  const agent = agents.find((a) => a?.id === AGENT_ID);
  if (!agent) throw new Error(`the registry has no "${AGENT_ID}" entry`);
  const binaries = agent.distribution?.binary || {};
  const key = PLATFORM_KEYS[`${platform}-${arch}`];
  const entry = key ? binaries[key] : null;
  if (!entry) {
    throw new Error(`no ${AGENT_ID} binary for ${platform}-${arch}; the registry has: ${Object.keys(binaries).join(', ') || '(none)'}`);
  }
  return { version: String(agent.version), archive: entry.archive, cmd: entry.cmd, args: entry.args || [] };
}

export function installedVersion(paths) {
  try { return basename(readlinkSync(paths.current)); } catch { return null; }
}

async function fetchRegistry(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return res.json();
}

// Every synchronous call below is bounded (timeout + SIGKILL), as
// test/exec-timeout-guard.test.mjs requires of a standalone script: not on the
// bridge thread is no reason to hang.
const DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000;
const UNPACK_TIMEOUT_MS = 10 * 60 * 1000;
const SIGN_TIMEOUT_MS = 5 * 60 * 1000;

// curl, not fetch: Node's fetch streamed the 316 MB archive in fifteen
// minutes on 2026-09-11 where curl took forty seconds, and this script already
// shells out for unzip and codesign.
function download(url, dest) {
  const progress = process.stderr.isTTY ? '--progress-bar' : '-sS';
  execFileSync('curl', ['-fL', progress, '-o', dest, url], { stdio: ['ignore', 'inherit', 'inherit'], timeout: DOWNLOAD_TIMEOUT_MS, killSignal: 'SIGKILL' });
}

function unzip(zip, dir) {
  mkdirSync(dir, { recursive: true });
  try {
    execFileSync('unzip', ['-q', '-o', zip, '-d', dir], { stdio: ['ignore', 'ignore', 'pipe'], timeout: UNPACK_TIMEOUT_MS, killSignal: 'SIGKILL' });
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    execFileSync('bsdtar', ['-xf', zip, '-C', dir], { stdio: ['ignore', 'ignore', 'pipe'], timeout: UNPACK_TIMEOUT_MS, killSignal: 'SIGKILL' });
  }
}

// macOS: the archive carries no checksum, so the code signature is the only
// provenance check available — and it is a strong one. Refuse anything that
// does not verify as Google's Developer ID. codesign writes its report to
// stderr, hence the shell redirect.
export function verifySignature(binary, { platform = process.platform, run = execFileSync } = {}) {
  if (platform !== 'darwin') return { verified: false, detail: `no signature check on ${platform} (the registry publishes no checksums)` };
  run('codesign', ['--verify', '--strict', binary], { stdio: ['ignore', 'ignore', 'pipe'], timeout: SIGN_TIMEOUT_MS, killSignal: 'SIGKILL' });
  const report = String(run('sh', ['-c', 'codesign -dv --verbose=2 "$1" 2>&1', 'sh', binary], { encoding: 'utf8', timeout: SIGN_TIMEOUT_MS, killSignal: 'SIGKILL' }));
  return { verified: report.includes(EXPECTED_AUTHORITY), detail: EXPECTED_AUTHORITY };
}

export async function install({ paths = antigravityAcpPaths(), registryUrl = REGISTRY_URL, log = console.error } = {}) {
  const registry = await fetchRegistry(registryUrl);
  const dist = selectDistribution(registry);
  const versionDir = join(paths.root, dist.version);
  const binary = join(versionDir, basename(dist.cmd));
  const already = installedVersion(paths);
  if (existsSync(binary) && already === dist.version) {
    log(`antigravity-acp ${dist.version} already installed at ${binary}`);
    return { version: dist.version, binary, changed: false };
  }
  mkdirSync(paths.root, { recursive: true });
  if (!existsSync(binary)) {
    const zip = join(tmpdir(), `antigravity-acp-${dist.version}-${process.pid}.zip`);
    log(`downloading ${dist.archive}`);
    try {
      download(dist.archive, zip);
      rmSync(versionDir, { recursive: true, force: true });
      unzip(zip, versionDir);
    } finally {
      rmSync(zip, { force: true });
    }
    if (!existsSync(binary)) throw new Error(`archive did not contain ${basename(dist.cmd)}`);
  }
  const sig = verifySignature(binary);
  if (process.platform === 'darwin' && !sig.verified) {
    rmSync(versionDir, { recursive: true, force: true });
    throw new Error(`${binary} is not signed by "${EXPECTED_AUTHORITY}"; removed`);
  }
  log(sig.verified ? `signature verified: ${sig.detail}` : sig.detail);
  writeFileSync(join(versionDir, 'registry-entry.json'), JSON.stringify({ fetchedAt: new Date().toISOString(), registryUrl, ...dist }, null, 2) + '\n');
  // Atomic re-point: a fresh link beside `current`, then rename over it.
  const tmpLink = `${paths.current}.tmp-${process.pid}`;
  rmSync(tmpLink, { force: true });
  symlinkSync(dist.version, tmpLink);
  renameSync(tmpLink, paths.current);
  log(`antigravity-acp ${dist.version} installed → ${paths.binary}`);
  return { version: dist.version, binary, changed: true };
}

// Drive the server's own login over stdio: `initialize` (v1), `authenticate`
// with the chosen method (the server prints the sign-in URL and opens the
// browser; the request answers when the flow completes), then one
// `session/new` on a scratch directory to prove the credential works — no
// prompt, no turn. The tier the account landed on is only in the server's
// stderr (`loadCodeAssist response: {'currentTier': …}`), so it is echoed.
export async function login({ binary = antigravityAcpPaths().binary, method = 'oauth-personal', log = console.error, timeoutMs = 10 * 60 * 1000 } = {}) {
  if (!existsSync(binary)) throw new Error(`${binary} is not installed; run this script without --login first`);
  const child = spawn(binary, process.platform === 'linux' ? ['--uid='] : [], { stdio: ['pipe', 'pipe', 'pipe'] });
  let id = 0; const pending = new Map(); let buf = ''; let tier = null;
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    for (const line of chunk.split('\n')) {
      if (/Open the following link/.test(line)) log(line.replace(/^.*?(Open the following link)/, '$1'));
      const m = /'currentTier': \{'id': '([^']+)', 'name': '([^']+)'/.exec(line);
      if (m) tier = { id: m[1], name: m[2] };
    }
  });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk; let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    }
  });
  const call = (method, params, ms) => new Promise((resolve, reject) => {
    const myId = ++id; pending.set(myId, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n');
    setTimeout(() => { if (pending.has(myId)) { pending.delete(myId); reject(new Error(`${method} did not answer within ${ms} ms`)); } }, ms).unref();
  });
  const cwd = join(tmpdir(), `antigravity-acp-login-${process.pid}`);
  mkdirSync(cwd, { recursive: true });
  try {
    const init = await call('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'agent-companion', version: '1.0.0' } }, 60_000);
    if (init.error) throw new Error(`initialize: ${init.error.message}`);
    const methods = (init.result?.authMethods || []).map((m) => m.id);
    if (!methods.includes(method)) throw new Error(`auth method "${method}" not offered; the server offers: ${methods.join(', ')}`);
    log(`agent ${init.result?.agentInfo?.name} ${init.result?.agentInfo?.version}: signing in with ${method} (finish it in the browser)…`);
    const auth = await call('authenticate', { methodId: method }, timeoutMs);
    if (auth.error) throw new Error(`authenticate: ${auth.error.message}`);
    const sn = await call('session/new', { cwd, mcpServers: [] }, 120_000);
    if (sn.error) throw new Error(`session/new after login: ${sn.error.message}`);
    const model = sn.result?.configOptions?.find((c) => c.id === 'model')?.currentValue ?? null;
    log(`signed in: tier ${tier ? `${tier.id} (${tier.name})` : '(not reported)'}, default model ${model || '(unknown)'}`);
    return { tier, model, authMethod: method };
  } finally {
    child.kill('SIGTERM');
    rmSync(cwd, { recursive: true, force: true });
  }
}

async function main(argv) {
  const paths = antigravityAcpPaths();
  if (argv.includes('--check')) {
    const registry = await fetchRegistry(REGISTRY_URL);
    const dist = selectDistribution(registry);
    const have = installedVersion(paths);
    console.log(`installed: ${have || '(none)'}  registry: ${dist.version}  binary: ${paths.binary}`);
    return have === dist.version ? 0 : 1;
  }
  await install({ paths });
  if (argv.includes('--login')) {
    const i = argv.indexOf('--method');
    await login({ binary: paths.binary, method: i >= 0 ? argv[i + 1] : 'oauth-personal' });
  }
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (err) => { console.error(`[FAIL] ${err.message}`); process.exit(1); });
}
