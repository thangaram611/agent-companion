// OpenCode server-mode adapter.
//
// Unlike opencode-runtime.mjs (single-shot `opencode run`), this adapter drives
// a long-lived `opencode serve` HTTP server so the bridge gains:
//   - in-flight reply / re-steer (abort the turn, prompt the same session again),
//   - restart resume (reattach to a surviving server + persisted session id),
//   - streamed events into richer digests (the `/event` SSE stream).
//
// Lifecycle mirrors the Copilot ACP daemon: the `opencode serve` process is
// spawned DETACHED and unref'd so it SURVIVES bridge restarts. A respawned
// bridge reattaches by probing the recorded base URL instead of spawning a
// duplicate. There is ONE shared server (not one per cwd): a single
// `opencode serve` roots each job's session at its own working directory via
// the `?directory=<cwd>` query param, which the server honours on session
// create, prompt, abort, the `/event` stream, and `/session/status`. (Verified
// against opencode 1.17.9: the no-param `/event` stream carries only events for
// the server's own launch cwd, so the directory param is mandatory.)
//
// Test seam: every side-effecting primitive (HTTP JSON, the SSE event stream,
// and server spawn) routes through module-local impl pointers that tests swap
// via `_setForTest` — reachable from server.test.mjs too, since the bridge calls
// these wrappers. The SSE parser is a pure accumulator (`createTurnAccumulator`)
// that can be unit-tested with plain strings — no socket required.

import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

import { resolveOpenCodeBin, resolveOpenCodePermissionMode, resolveOpenCodeTimeoutMs } from './opencode-runtime.mjs';
import { openCodeServerRegistryPath, writePrivateFileAtomic } from '../lib/runtime-paths.mjs';
import { truncateChars, MAX_SUMMARY_CHARS } from '../lib/text-utils.mjs';

const MAX_TRANSCRIPT_CHARS = 12_000;
const SERVER_BOOT_TIMEOUT_MS = 15_000;
const HEALTH_PROBE_TIMEOUT_MS = 2_000;
// One server for the whole bridge; sessions are scoped per cwd via ?directory=.
const SHARED_SERVER_KEY = 'shared';

// ---------------------------------------------------------------------------
// Adapter selection
// ---------------------------------------------------------------------------

export function resolveOpenCodeAdapter(env = process.env) {
  const raw = String(env.OPENCODE_RUNTIME_ADAPTER || 'cli').trim().toLowerCase();
  return raw === 'server' ? 'server' : 'cli';
}

export function openCodeServerActive(env = process.env) {
  return resolveOpenCodeAdapter(env) === 'server';
}

// Split a `provider/model` string into the server prompt API's
// { providerID, modelID } shape. Returns null when empty/malformed.
export function parseOpenCodeModel(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const slash = s.indexOf('/');
  if (slash <= 0 || slash === s.length - 1) return null;
  return { providerID: s.slice(0, slash), modelID: s.slice(slash + 1) };
}

// The env-default model (server uses its own configured default when unset).
export function resolveOpenCodeServerModel(env = process.env) {
  return parseOpenCodeModel(env.AGENT_COMPANION_OPENCODE_MODEL);
}

export function openCodeServerRuntimeInfo(env = process.env) {
  return {
    adapter: resolveOpenCodeAdapter(env),
    bin: resolveOpenCodeBin(env),
    model: resolveOpenCodeServerModel(env),
    permission: resolveOpenCodePermissionMode(env),
    timeout_ms: resolveOpenCodeTimeoutMs(env),
  };
}

export function openCodeServerPromptId(jobId, replyTurn = 0) {
  return replyTurn > 0 ? `opencode-${jobId}-r${replyTurn}` : `opencode-${jobId}`;
}

// ---------------------------------------------------------------------------
// Injectable I/O seam (default impls use global fetch / spawn)
// ---------------------------------------------------------------------------

async function realFetchJson(url, { method = 'GET', body = null, signal = null, timeoutMs = 30_000 } = {}) {
  const ac = signal ? null : new AbortController();
  const finalSignal = signal || ac?.signal;
  const timer = ac ? setTimeout(() => ac.abort(), timeoutMs) : null;
  if (timer?.unref) timer.unref();
  try {
    const res = await fetch(url, {
      method,
      signal: finalSignal,
      headers: body != null ? { 'content-type': 'application/json' } : undefined,
      body: body != null ? JSON.stringify(body) : undefined,
    });
    let data = null;
    const text = await res.text();
    if (text) { try { data = JSON.parse(text); } catch { data = text; } }
    return { ok: res.ok, status: res.status, data };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Open the `/event` SSE stream. Resolves once the HTTP connection is established
// (so the caller can sequence subscribe-then-prompt), returning an async iterable
// of decoded text chunks. The caller aborts `signal` to stop; we never buffer the
// whole stream. TCP/stream buffering preserves events that arrive between connect
// and the first iteration, so a session.idle just after connect is not lost.
async function realOpenEventStream(url, { signal = null } = {}) {
  const res = await fetch(url, { signal, headers: { accept: 'text/event-stream' } });
  if (!res.ok || !res.body) {
    throw new Error(`opencode /event stream failed: HTTP ${res.status}`);
  }
  return (async function* () {
    const decoder = new TextDecoder();
    for await (const chunk of res.body) {
      yield typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    }
  })();
}

function realSpawnServer({ bin, args, env }) {
  const child = spawn(bin, args, { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  return child;
}

let _impl = {
  fetchJson: realFetchJson,
  openEventStream: realOpenEventStream,
  spawnServer: realSpawnServer,
};

export function _setForTest(overrides = {}) {
  _impl = { ..._impl, ...overrides };
}

export function _resetForTest() {
  _impl = { fetchJson: realFetchJson, openEventStream: realOpenEventStream, spawnServer: realSpawnServer };
  _serverCache.clear();
  _spawnLocks.clear();
}

// ---------------------------------------------------------------------------
// Pure SSE accumulator — terminal detection + transcript assembly
// ---------------------------------------------------------------------------
//
// Feed it raw `/event` stream text via push(); it tracks the assistant message
// for one session and reports a terminal verdict once `session.idle` (or
// `session.error`) arrives for that session. No I/O — unit-testable directly.

export function createTurnAccumulator(sessionId) {
  let pending = '';
  // assistant message id -> { textParts: Map(partId->text), reasoning: Map, tools: Map }
  const messages = new Map();
  let latestAssistantId = null;
  let aborted = false;
  let messageError = null; // { name, message }
  let terminal = null; // { status }
  let sawEvent = false;

  function partText(map) {
    return [...map.values()].map((s) => String(s || '')).join('');
  }

  function snapshotMessage(id) {
    const m = messages.get(id);
    if (!m) return { text: '', thoughts: '', tools: [] };
    return {
      text: partText(m.textParts),
      thoughts: partText(m.reasoning),
      tools: [...m.tools.values()],
    };
  }

  function ensureMessage(id) {
    if (!messages.has(id)) messages.set(id, { textParts: new Map(), reasoning: new Map(), tools: new Map() });
    return messages.get(id);
  }

  function onEvent(evt) {
    if (!evt || typeof evt !== 'object') return;
    const type = String(evt.type || '');
    const props = evt.properties || {};
    // Global noise (no sessionID, or a different session) is ignored.
    if (props.sessionID && props.sessionID !== sessionId) return;
    sawEvent = true;

    if (type === 'message.updated') {
      const info = props.info || {};
      if (info.role === 'assistant') {
        latestAssistantId = info.id || latestAssistantId;
        if (info.id) ensureMessage(info.id);
        if (info.error) {
          const name = info.error.name || info.error.type || 'error';
          messageError = { name, message: info.error.message || info.error.data?.message || name };
          if (/abort/i.test(name)) aborted = true;
        }
      }
      return;
    }

    if (type === 'message.part.updated') {
      const part = props.part || {};
      const mid = part.messageID;
      if (!mid) return;
      const m = ensureMessage(mid);
      // Any part (text/tool/reasoning) belongs to the assistant message, so a
      // tool-only or reasoning-only turn still resolves to the right snapshot.
      latestAssistantId = mid;
      if (part.id == null) return;
      if (part.type === 'text' && typeof part.text === 'string') {
        if (!part.synthetic && !part.ignored) m.textParts.set(part.id, part.text);
      } else if (part.type === 'reasoning' && typeof part.text === 'string') {
        m.reasoning.set(part.id, part.text);
      } else if (part.type === 'tool') {
        m.tools.set(part.id, {
          name: part.tool || part.name || 'tool',
          input: part.state?.input || part.input || {},
          status: part.state?.status || null,
        });
      }
      return;
    }

    if (type === 'session.error') {
      const err = props.error || {};
      const name = err.name || err.type || 'session.error';
      messageError = { name, message: err.message || err.data?.message || name };
      if (/abort/i.test(name)) aborted = true;
      terminal = { status: aborted ? 'cancelled' : 'failed' };
      return;
    }

    if (type === 'session.idle') {
      if (aborted || (messageError && /abort/i.test(messageError.name))) {
        terminal = { status: 'cancelled' };
      } else if (messageError) {
        terminal = { status: 'failed' };
      } else {
        terminal = { status: 'completed' };
      }
    }
  }

  return {
    // Feed raw SSE text; parses complete `\n\n`-delimited frames.
    push(text) {
      pending += text;
      let idx;
      while ((idx = pending.indexOf('\n\n')) !== -1) {
        const frame = pending.slice(0, idx);
        pending = pending.slice(idx + 2);
        consumeFrame(frame);
      }
    },
    // Flush a trailing partial frame (used on stream close).
    flush() {
      if (pending.trim()) consumeFrame(pending);
      pending = '';
    },
    get terminal() { return terminal; },
    get sawEvent() { return sawEvent; },
    snapshot() {
      const snap = latestAssistantId ? snapshotMessage(latestAssistantId) : { text: '', thoughts: '', tools: [] };
      return {
        message: truncateChars(snap.text, MAX_SUMMARY_CHARS),
        thoughts: truncateChars(snap.thoughts, MAX_SUMMARY_CHARS),
        toolCalls: snap.tools.map((t) => ({ name: t.name, input: t.input })),
        error: messageError ? messageError.message : null,
      };
    },
  };

  function consumeFrame(frame) {
    for (const line of frame.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const json = trimmed.slice(5).trim();
      if (!json) continue;
      let evt;
      try { evt = JSON.parse(json); } catch { continue; }
      onEvent(evt);
    }
  }
}

// ---------------------------------------------------------------------------
// Server pool — one detached `opencode serve` per working directory
// ---------------------------------------------------------------------------

const _serverCache = new Map(); // key -> { baseUrl, pid }
const _spawnLocks = new Map();  // key -> Promise

// A lease is one bridge process's claim that it has a job actively using the
// shared server. Leases live in the on-disk registry rather than in memory
// because the thing they protect is machine-wide: `opencode serve` is shared by
// every bridge, and the bridge is spawned per subagent, so "this process has no
// live jobs" says nothing about whether the server is in use.
//
// Each lease is renewed on its owner's GC tick. A lease whose owning pid is
// gone, or that has not been renewed in LEASE_STALE_MS, is abandoned and gets
// pruned — otherwise a hard-killed bridge would pin the server forever.
const LEASE_STALE_MS = 5 * 60 * 1000;

// How long a published disposal claim is honored. Long enough to cover the
// dispose round-trip, short enough that a reaper killed mid-dispose cannot make
// the server permanently unadoptable.
const DISPOSAL_CLAIM_TTL_MS = 30 * 1000;

// How long the shared server may sit unused before the reaper disposes it.
//
// This floor MUST clear the longest a single job can occupy the server. It used
// to be a bare 30min constant in server.mjs while opencode jobs were allowed
// 40min, so a job that simply ran long looked indistinguishable from an idle
// server. Deriving it from the job timeout is what stops the two numbers from
// being chosen independently and drifting apart again — which is how they got
// out of step in the first place.
const MIN_IDLE_TTL_MS = 30 * 60 * 1000;
const IDLE_TTL_GRACE_MS = 5 * 60 * 1000;

export function openCodeServerIdleTtlMs(env = process.env) {
  return Math.max(MIN_IDLE_TTL_MS, resolveOpenCodeTimeoutMs(env) + IDLE_TTL_GRACE_MS);
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the pid exists but belongs to another user — still alive.
    return err.code === 'EPERM';
  }
}

// Drop leases whose owner died or stopped renewing. Returns a fresh object plus
// whether anything was removed (so callers can skip a pointless registry write).
function pruneLeases(leases, now) {
  const kept = {};
  let changed = false;
  for (const [leaseId, lease] of Object.entries(leases || {})) {
    const renewedAt = Number(lease?.renewedAt) || 0;
    if (pidAlive(Number(lease?.pid)) && now - renewedAt < LEASE_STALE_MS) kept[leaseId] = lease;
    else changed = true;
  }
  return { leases: kept, changed };
}

function readRegistry() {
  try {
    const path = openCodeServerRegistryPath();
    if (!existsSync(path)) return {};
    const data = JSON.parse(readFileSync(path, 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch { return {}; }
}

// Atomic, because every bridge on the machine reads this file and lease renewal
// now rewrites it on a heartbeat. A truncate-then-write would let a reader catch
// the file mid-write; readRegistry treats unparseable as empty, and an empty
// registry makes ensureOpenCodeServer spawn a SECOND `opencode serve` rather
// than reattach to the live one.
function writeRegistry(reg) {
  try {
    const path = openCodeServerRegistryPath();
    writePrivateFileAtomic(path, JSON.stringify(reg, null, 2));
  } catch { /* registry is best-effort */ }
}

function recordServer(key, entry) {
  const reg = readRegistry();
  reg[key] = { ...entry, lastUsedAt: Date.now() };
  writeRegistry(reg);
}

function forgetServer(key) {
  const reg = readRegistry();
  if (key in reg) { delete reg[key]; writeRegistry(reg); }
  _serverCache.delete(key);
}

async function probeHealth(baseUrl) {
  try {
    const r = await _impl.fetchJson(`${baseUrl}/global/health`, { timeoutMs: HEALTH_PROBE_TIMEOUT_MS });
    return !!(r.ok && r.data && r.data.healthy);
  } catch { return false; }
}

// Is a specific server base URL still listening? Used by restart resume to tell
// "the original server (and its in-flight turn) survived" from "it is gone".
export async function probeOpenCodeServerHealth(baseUrl) {
  if (!baseUrl) return false;
  return probeHealth(baseUrl);
}

// Resolve the shared server base URL, reusing a surviving server (this process,
// then the on-disk registry from a prior bridge) when one is still listening,
// otherwise spawning a fresh detached one. Concurrent callers share one spawn.
export async function ensureOpenCodeServer({ env = process.env } = {}) {
  const key = SHARED_SERVER_KEY;

  // A server another bridge has claimed for disposal is about to stop answering
  // even though it is healthy right now. Adopting it would hand this job a
  // server that dies underneath it, so treat a live claim as "gone" and spawn
  // our own. Health alone is not enough to tell those two apart.
  const claimed = (base) => {
    const reg = readRegistry()[key];
    return reg?.baseUrl === base && !!disposalClaimedBy(reg);
  };

  const cached = _serverCache.get(key);
  if (cached && !claimed(cached.baseUrl) && await probeHealth(cached.baseUrl)) {
    recordServer(key, { ...readRegistry()[key], baseUrl: cached.baseUrl, pid: cached.pid });
    return { baseUrl: cached.baseUrl, pid: cached.pid, reused: true };
  }
  if (cached) _serverCache.delete(key);

  const recorded = readRegistry()[key];
  if (recorded?.baseUrl && !disposalClaimedBy(recorded) && await probeHealth(recorded.baseUrl)) {
    _serverCache.set(key, { baseUrl: recorded.baseUrl, pid: recorded.pid });
    recordServer(key, recorded);
    return { baseUrl: recorded.baseUrl, pid: recorded.pid, reused: true };
  }
  if (recorded) forgetServer(key);

  if (_spawnLocks.has(key)) return _spawnLocks.get(key);
  const spawnPromise = spawnServer(key, env).finally(() => _spawnLocks.delete(key));
  _spawnLocks.set(key, spawnPromise);
  return spawnPromise;
}

async function spawnServer(key, env) {
  const bin = resolveOpenCodeBin(env);
  const args = ['serve', '--port', '0', '--hostname', '127.0.0.1'];
  const child = _impl.spawnServer({ bin, args, env });
  let baseUrl;
  try {
    baseUrl = await waitForBootUrl(child);
  } catch (err) {
    // Boot timed out or the server exited before listening. Don't leak the
    // detached child — kill it (SIGTERM, then SIGKILL) before propagating.
    try { child.kill?.('SIGTERM'); } catch {}
    const hardKill = setTimeout(() => { try { child.kill?.('SIGKILL'); } catch {} }, 2_000);
    if (hardKill.unref) hardKill.unref();
    throw err;
  }
  try { child.unref?.(); } catch {}
  const pid = child.pid || null;
  _serverCache.set(key, { baseUrl, pid });
  recordServer(key, { baseUrl, pid, startedAt: Date.now() });
  return { baseUrl, pid, reused: false };
}

// Snapshot of the shared server for status/observability.
export function openCodeServerPoolSnapshot() {
  const reg = readRegistry();
  const entry = reg[SHARED_SERVER_KEY] || null;
  return entry ? { ...entry } : null;
}

// Publish this process's in-flight server-mode jobs as leases, and prune every
// abandoned lease (ours or another bridge's) while we hold the file. Call this
// on a heartbeat — it is a full reconcile, not an increment, so a lease lost to
// a concurrent read-modify-write is simply re-added on the next tick.
//
// Holding a lease also refreshes `lastUsedAt`. That is what makes a job longer
// than the idle TTL safe: the server counts as "in use" for as long as someone
// is actually using it, instead of only at the moment the job started.
export function syncOpenCodeServerLeases(jobIds = [], { now = Date.now(), pid = process.pid } = {}) {
  const reg = readRegistry();
  const entry = reg[SHARED_SERVER_KEY];
  if (!entry) return { leases: {}, mine: 0 };

  const { leases, changed } = pruneLeases(entry.leases, now);
  // Reconcile our own leases: drop the ones whose jobs went terminal, then
  // (re)stamp the live ones. Other processes' surviving leases are untouched.
  let heldBefore = 0;
  for (const [leaseId, lease] of Object.entries(leases)) {
    if (Number(lease?.pid) === pid) { heldBefore += 1; delete leases[leaseId]; }
  }
  for (const jobId of jobIds) leases[`${pid}:${jobId}`] = { pid, jobId, renewedAt: now };

  // An idle bridge with nothing to say must not touch the file. This runs on
  // every GC tick in every bridge on the machine; writing unconditionally would
  // be pure contention on a file they all read, for no change in content.
  if (jobIds.length === 0 && heldBefore === 0 && !changed) return { leases, mine: 0 };

  const next = { ...entry, leases };
  if (jobIds.length > 0) next.lastUsedAt = now;
  reg[SHARED_SERVER_KEY] = next;
  writeRegistry(reg);
  return { leases, mine: jobIds.length };
}

// Best-effort idle reaper: dispose the shared server only when it has gone
// `idleMs` without use AND no bridge on this machine holds a live lease on it.
//
// `hasLiveJobs` is this process's own view and stays as a cheap short-circuit,
// but it is not sufficient on its own: the server is shared machine-wide while
// the bridge is spawned per subagent, so a second bridge with an empty job map
// used to be able to dispose a server out from under someone else's running
// turn. Leases close that hole.
//
// Failures are swallowed (the server is detached and self-contained).
export async function reapIdleOpenCodeServer({ idleMs, hasLiveJobs = false, now = Date.now() } = {}) {
  if (hasLiveJobs) return false;
  const reg = readRegistry();
  const entry = reg[SHARED_SERVER_KEY];
  if (!entry?.baseUrl || !entry.lastUsedAt) return false;

  const { leases, changed } = pruneLeases(entry.leases, now);
  if (changed) {
    reg[SHARED_SERVER_KEY] = { ...entry, leases };
    writeRegistry(reg);
  }
  // Another bridge is mid-turn on this server. Its own reaper will dispose it
  // once its jobs finish and the server actually goes idle.
  if (Object.keys(leases).length > 0) return false;

  if (now - entry.lastUsedAt < idleMs) return false;

  // Claim the disposal BEFORE the HTTP call. Deciding and then disposing is not
  // enough on its own: a lease can only exist once a job exists, so a bridge
  // that adopts this server in the window between our check and our dispose
  // landing has no way to warn us, and we would kill its turn. Publishing the
  // intent lets the adopter see it (ensureOpenCodeServer refuses a server that
  // is being disposed and spawns its own), and re-reading after we publish lets
  // us see an adopter who got in first. Both sides fail safe: the worst case is
  // one redundant server spawn, never a disposed server with a live job on it.
  if (!claimDisposal(entry, now)) return false;

  try { await _impl.fetchJson(`${entry.baseUrl}/global/dispose`, { method: 'POST', timeoutMs: HEALTH_PROBE_TIMEOUT_MS }); }
  catch { /* server may already be gone */ }
  // Re-read rather than blind-delete: forgetServer drops the whole entry, so if
  // another bridge replaced this server while we disposed the old one, an
  // unconditional delete would erase the replacement and its leases too.
  const after = readRegistry()[SHARED_SERVER_KEY];
  if (!after || after.baseUrl === entry.baseUrl) forgetServer(SHARED_SERVER_KEY);
  return true;
}

// Publish `disposing` and confirm we still own the decision. Returns false if
// anyone raced us — a lease appeared, the server was used again, the entry was
// replaced, or another reaper claimed it first.
function claimDisposal(entry, now) {
  const reg = readRegistry();
  const current = reg[SHARED_SERVER_KEY];
  if (!current || current.baseUrl !== entry.baseUrl) return false;
  if (disposalClaimedBy(current, now)) return false;

  reg[SHARED_SERVER_KEY] = { ...current, disposing: { pid: process.pid, at: now } };
  writeRegistry(reg);

  const confirm = readRegistry()[SHARED_SERVER_KEY];
  const claim = confirm?.disposing;
  if (!confirm || confirm.baseUrl !== entry.baseUrl || claim?.pid !== process.pid) return false;
  // Someone adopted the server between our decision and our claim. Stand down —
  // and withdraw the claim, or it would block adoption until the TTL expires
  // and cost them a redundant server spawn for nothing.
  if (Object.keys(pruneLeases(confirm.leases, now).leases).length > 0 || confirm.lastUsedAt !== entry.lastUsedAt) {
    releaseDisposalClaim(entry.baseUrl);
    return false;
  }
  return true;
}

function releaseDisposalClaim(baseUrl) {
  const reg = readRegistry();
  const current = reg[SHARED_SERVER_KEY];
  if (!current || current.baseUrl !== baseUrl || current.disposing?.pid !== process.pid) return;
  const { disposing, ...rest } = current;
  reg[SHARED_SERVER_KEY] = rest;
  writeRegistry(reg);
}

// Is a disposal claim in force? Claims expire so a reaper that died mid-dispose
// cannot make the server permanently unadoptable.
function disposalClaimedBy(entry, now = Date.now()) {
  const claim = entry?.disposing;
  if (!claim) return null;
  if (now - (Number(claim.at) || 0) > DISPOSAL_CLAIM_TTL_MS) return null;
  return claim;
}

export { LEASE_STALE_MS };

// Parse the `listening on http://host:port` boot line from the server's stdout.
function waitForBootUrl(child) {
  return new Promise((resolve, reject) => {
    let buf = '';
    let settled = false;
    const done = (fn, arg) => { if (!settled) { settled = true; cleanup(); fn(arg); } };
    const onData = (chunk) => {
      buf += chunk.toString('utf8');
      const m = buf.match(/listening on\s+(https?:\/\/[^\s]+)/i);
      if (m) done(resolve, m[1].replace(/\/+$/, ''));
    };
    const onErr = (err) => done(reject, err);
    const onClose = (code) => done(reject, new Error(`opencode serve exited before listening (code ${code})`));
    const timer = setTimeout(() => done(reject, new Error('opencode serve did not report a listening URL in time')), SERVER_BOOT_TIMEOUT_MS);
    if (timer.unref) timer.unref();
    function cleanup() {
      clearTimeout(timer);
      child.stdout?.off?.('data', onData);
      child.stderr?.off?.('data', onData);
      child.off?.('error', onErr);
      child.off?.('close', onClose);
    }
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('error', onErr);
    child.on('close', onClose);
  });
}

// ---------------------------------------------------------------------------
// Session operations  (all directory-scoped: opencode roots/serves a session by
// the ?directory= param, NOT by the server's launch cwd)
// ---------------------------------------------------------------------------

function dirQuery(directory) {
  return directory ? `?directory=${encodeURIComponent(directory)}` : '';
}

export async function createOpenCodeSession({ baseUrl, directory = null, title = null }) {
  const body = {};
  if (title) body.title = title;
  const r = await _impl.fetchJson(`${baseUrl}/session${dirQuery(directory)}`, { method: 'POST', body });
  if (!r.ok || !r.data?.id) {
    throw new Error(`opencode session create failed: HTTP ${r.status}`);
  }
  return r.data.id;
}

export async function startOpenCodeServerPrompt({ baseUrl, sessionId, directory = null, prompt, model = null, agent = null }) {
  const body = { parts: [{ type: 'text', text: prompt }] };
  if (model) body.model = model;
  if (agent) body.agent = agent;
  const r = await _impl.fetchJson(`${baseUrl}/session/${encodeURIComponent(sessionId)}/prompt_async${dirQuery(directory)}`, {
    method: 'POST', body,
  });
  if (!r.ok) throw new Error(`opencode prompt_async failed: HTTP ${r.status}`);
  return r.data || { ok: true };
}

export async function abortOpenCodeSession({ baseUrl, sessionId, directory = null }) {
  try {
    const r = await _impl.fetchJson(`${baseUrl}/session/${encodeURIComponent(sessionId)}/abort${dirQuery(directory)}`, { method: 'POST' });
    return { ok: r.ok, aborted: r.data === true || r.ok };
  } catch (err) {
    return { ok: false, aborted: false, error: err.message };
  }
}

// session-level busy/idle, directory-scoped. Returns 'busy' | 'idle' | 'unknown'.
// `/session/status` reports `{ "<sessionID>": { type: "busy" } }` for running
// sessions and `{}` when idle.
export async function getOpenCodeSessionStatus({ baseUrl, sessionId, directory = null }) {
  try {
    const r = await _impl.fetchJson(`${baseUrl}/session/status${dirQuery(directory)}`, { timeoutMs: HEALTH_PROBE_TIMEOUT_MS });
    if (!r.ok || !r.data || typeof r.data !== 'object') return 'unknown';
    const entry = r.data[sessionId];
    if (!entry) return 'idle';
    return entry.type === 'busy' ? 'busy' : 'idle';
  } catch { return 'unknown'; }
}

// Build a terminal/partial transcript snapshot from the persisted message list.
// Used for resume (turn already finished while bridge was down) and digests.
// The message list reads without the directory param.
export async function loadOpenCodeTranscript({ baseUrl, sessionId, directory = null }) {
  const r = await _impl.fetchJson(`${baseUrl}/session/${encodeURIComponent(sessionId)}/message${dirQuery(directory)}`, { timeoutMs: 10_000 });
  if (!r.ok || !Array.isArray(r.data)) return { completed: false, summary: emptySummary(), found: false };
  const assistant = [...r.data].reverse().find((m) => m?.info?.role === 'assistant');
  if (!assistant) return { completed: false, summary: emptySummary(), found: r.data.length > 0 };
  const parts = assistant.parts || [];
  const text = parts.filter((p) => p.type === 'text' && !p.synthetic && !p.ignored).map((p) => p.text).join('');
  const thoughts = parts.filter((p) => p.type === 'reasoning').map((p) => p.text).join('');
  const tools = parts.filter((p) => p.type === 'tool').map((p) => ({ name: p.tool || p.name || 'tool', input: p.state?.input || p.input || {} }));
  const err = assistant.info.error;
  return {
    found: true,
    completed: !!assistant.info?.time?.completed || !!err,
    aborted: !!(err && /abort/i.test(err.name || err.type || '')),
    error: err ? (err.message || err.name || 'error') : null,
    summary: {
      message: truncateChars(text, MAX_SUMMARY_CHARS),
      thoughts: truncateChars(thoughts, MAX_SUMMARY_CHARS),
      toolCalls: tools,
      stopReason: 'idle',
      error: err ? (err.message || err.name || 'error') : null,
    },
  };
}

// ---------------------------------------------------------------------------
// Turn watcher — subscribe to /event?directory, resolve on terminal
// ---------------------------------------------------------------------------
//
// `openOpenCodeTurnWatcher` is async: it resolves once the directory-scoped SSE
// connection is established, so the caller can safely fire prompt_async without
// racing session.idle. It returns a `done` promise that settles with the
// terminal envelope. Detection is level- AND edge-triggered:
//   - level: an optional immediate /session/status + transcript check closes the
//     "session.idle fired before we subscribed" race (the /event stream has no
//     replay/since cursor), needed by restart resume.
//   - edge: the SSE accumulator resolves on session.idle / session.error.
//   - fallback: a stream that drops without a terminal frame re-probes status +
//     health to distinguish a finished turn from a dead server.

export async function openOpenCodeTurnWatcher({ baseUrl, sessionId, directory = null, onEvent = null, timeoutMs = null, initialLevelCheck = false }) {
  const ac = new AbortController();
  const acc = createTurnAccumulator(sessionId);

  // Establish the subscription first (this await = "connected"). Stream/TCP
  // buffering preserves any frames that land before we start iterating.
  const stream = await _impl.openEventStream(`${baseUrl}/event${dirQuery(directory)}`, { signal: ac.signal });

  // Resume path: the turn may already be terminal. Check level state up front.
  let preTerminal = null;
  if (initialLevelCheck) {
    preTerminal = await levelTerminal({ baseUrl, sessionId, directory });
  }

  let timer = null;
  let timedOut = false;

  const done = (async () => {
    if (preTerminal) { try { ac.abort(); } catch {} return preTerminal; }
    if (timeoutMs && timeoutMs > 0) {
      timer = setTimeout(() => { timedOut = true; ac.abort(); }, timeoutMs);
      if (timer?.unref) timer.unref();
    }
    try {
      for await (const chunk of stream) {
        acc.push(chunk);
        if (onEvent) { try { onEvent(acc.snapshot()); } catch {} }
        if (acc.terminal) break;
      }
      acc.flush();
    } catch (err) {
      if (!timedOut) {
        return acc.terminal
          ? finalize(acc, { status: acc.terminal.status, stopReason: 'idle' })
          : streamDropFallback(acc, { baseUrl, sessionId, directory, error: err.message });
      }
    } finally {
      if (timer) clearTimeout(timer);
      try { ac.abort(); } catch {}
    }
    if (timedOut && !acc.terminal) {
      return finalize(acc, { status: 'timeout', error: 'opencode turn watch timed out', stopReason: 'timeout' });
    }
    if (!acc.terminal) {
      return streamDropFallback(acc, { baseUrl, sessionId, directory, error: 'opencode /event stream closed before session.idle' });
    }
    return finalize(acc, { status: acc.terminal.status, stopReason: 'idle' });
  })();

  return { done, close: () => { try { ac.abort(); } catch {} } };
}

// Level check: if the session is idle/absent and its transcript shows a completed
// (or errored/aborted) assistant message, return a terminal envelope from the
// transcript. Otherwise null (turn still running or indeterminate).
async function levelTerminal({ baseUrl, sessionId, directory }) {
  const status = await getOpenCodeSessionStatus({ baseUrl, sessionId, directory });
  if (status === 'busy') return null;
  let transcript = null;
  try { transcript = await loadOpenCodeTranscript({ baseUrl, sessionId, directory }); } catch { return null; }
  if (!transcript?.completed) return null;
  return transcriptEnvelope(transcript);
}

// Stream dropped without a terminal frame. Distinguish a finished turn (status
// idle + completed transcript) from a dead server (health fails) from a genuinely
// indeterminate drop.
async function streamDropFallback(acc, { baseUrl, sessionId, directory, error }) {
  const status = await getOpenCodeSessionStatus({ baseUrl, sessionId, directory });
  if (status === 'idle') {
    try {
      const transcript = await loadOpenCodeTranscript({ baseUrl, sessionId, directory });
      if (transcript?.completed) return transcriptEnvelope(transcript);
    } catch { /* fall through */ }
  }
  const alive = await probeHealth(baseUrl);
  if (!alive) {
    return finalize(acc, { status: 'unreachable', error: 'opencode server is gone; the in-flight turn was lost', stopReason: 'server-gone' });
  }
  return finalize(acc, { status: 'unreachable', error: error || 'opencode /event stream closed before session.idle', stopReason: 'stream-closed' });
}

function transcriptEnvelope(transcript) {
  const status = transcript.aborted ? 'cancelled' : (transcript.error ? 'failed' : 'completed');
  return {
    status,
    summary: transcript.summary,
    error: status === 'failed' ? transcript.error : null,
    stdout: transcript.summary?.message || '',
    stderr: '',
  };
}

function finalize(acc, { status, error = null, stopReason }) {
  const snap = acc.snapshot();
  const message = snap.message || '';
  const summary = {
    message,
    thoughts: snap.thoughts || '',
    toolCalls: snap.toolCalls || [],
    stopReason,
    error: error || snap.error || null,
  };
  return {
    status,
    summary,
    error: status === 'failed' || status === 'unreachable' || status === 'timeout' ? (error || snap.error || null) : null,
    stdout: message,
    stderr: '',
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function emptySummary() {
  return { message: '', thoughts: '', toolCalls: [], stopReason: 'idle', error: null };
}

export { MAX_TRANSCRIPT_CHARS };
