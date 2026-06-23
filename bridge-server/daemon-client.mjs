// daemon-client.mjs
// Minimal in-process client for the copilot-acp-daemon. Talks the same
// newline-delimited JSON protocol as scripts/copilot-acp-client.mjs but
// skips the node-subprocess overhead — the bridge server worker calls
// these functions directly inside the same process.
//
// Two functions exported:
//   sendToSocket(message, timeoutMs?) — round-trip one IPC request
//   ensureDaemon({reqId?}) — auto-spawn the daemon if its socket isn't responding
//
// v6.1: optional reqId is appended to outbound messages so the daemon can
// stamp every log line with the same correlation id.

import { connect as connectSocket } from 'node:net';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as pathResolve } from 'node:path';

import { daemonSocketPath } from '../lib/runtime-paths.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DAEMON_PATH = process.env.COPILOT_DAEMON_PATH
  || pathResolve(__dirname, '..', 'scripts', 'copilot-acp-daemon.mjs');
const DAEMON_BOOT_TIMEOUT_MS = Number(process.env.COPILOT_DAEMON_BOOT_MS) || 8_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 6 * 60 * 1000;

function realSendToSocket(message, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const sock = connectSocket(daemonSocketPath());
    let buf = '';
    const timer = setTimeout(() => {
      sock.destroy();
      const err = new Error('client request timeout');
      err.code = 'ETIMEDOUT';
      reject(err);
    }, timeoutMs);

    sock.on('connect', () => {
      sock.write(JSON.stringify(message));
      sock.end();
    });
    sock.setEncoding('utf8');
    sock.on('data', (chunk) => (buf += chunk));
    sock.on('end', () => {
      clearTimeout(timer);
      try { resolve(JSON.parse(buf.trim())); }
      catch (err) { reject(new Error(`invalid response from daemon: ${err.message}`)); }
    });
    sock.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function isDaemonAlive() {
  try {
    const r = await sendToSocket({ command: 'status' }, 2000);
    return r && r.ok === true;
  } catch {
    return false;
  }
}

// Spawn mutex: concurrent ensureDaemon() callers must share the same
// in-flight spawn promise. Without this two parallel `send` actions would
// each try to spawn a daemon, racing on the socket file.
let _spawnPromise = null;

async function spawnDaemon() {
  if (_spawnPromise) return _spawnPromise;
  _spawnPromise = (async () => {
    if (!existsSync(DAEMON_PATH)) {
      throw new Error(`daemon not found at ${DAEMON_PATH}`);
    }
    const child = spawn(process.execPath, [DAEMON_PATH], { detached: true, stdio: 'ignore' });
    child.unref();
    // Exponential backoff probe — fastest case ~50 ms, capped at the boot
    // timeout. Old fixed-100 ms loop wasted ~6× boot latency.
    const delays = [50, 100, 200, 400, 800];
    let i = 0;
    const start = Date.now();
    while (Date.now() - start < DAEMON_BOOT_TIMEOUT_MS) {
      await new Promise((r) => setTimeout(r, delays[Math.min(i, delays.length - 1)]));
      i++;
      if (await isDaemonAlive()) return;
    }
    throw new Error('daemon failed to start within timeout');
  })();
  try { return await _spawnPromise; }
  finally { _spawnPromise = null; }
}

async function realEnsureDaemon({ reqId } = {}) {
  // Try a short probe first — if the daemon is already up the cost is one
  // round-trip on the socket. Skip the longer status timeout since "alive"
  // here means "socket accepts a connection", not "everything healthy".
  try {
    const r = await sendToSocket({ command: 'status', reqId }, 1500);
    if (r && r.ok === true) return;
  } catch (err) {
    // Only auto-spawn on connect-class failures. Anything else (parse
    // errors, server-side rejection) bubbles up so callers can decide.
    if (!err || !['ECONNREFUSED', 'ENOENT', 'ETIMEDOUT'].includes(err.code)) {
      throw err;
    }
  }
  await spawnDaemon();
}

// Module-local impl pointers — tests can swap these via _setForTest without
// touching the real socket / spawn. server.mjs imports the public wrappers
// below as named bindings, so the indirection has to live here (ESM named
// imports can't be rebound from outside).
let _sendToSocketImpl = realSendToSocket;
let _ensureDaemonImpl = realEnsureDaemon;

export function sendToSocket(message, timeoutMs) {
  return _sendToSocketImpl(message, timeoutMs);
}

export function ensureDaemon(opts) {
  return _ensureDaemonImpl(opts);
}

export function _setForTest({ sendToSocket: sendStub, ensureDaemon: ensureStub } = {}) {
  if (sendStub) _sendToSocketImpl = sendStub;
  if (ensureStub) _ensureDaemonImpl = ensureStub;
}

export function _resetForTest() {
  _sendToSocketImpl = realSendToSocket;
  _ensureDaemonImpl = realEnsureDaemon;
}
