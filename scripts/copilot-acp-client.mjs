#!/usr/bin/env node
// copilot-acp-client.mjs
// Stateless CLI client for the copilot-acp-daemon. Communicates over a Unix
// domain socket using newline-delimited JSON. Auto-spawns the daemon if not
// running. All output is single-line JSON to stdout.

import { connect as connectSocket } from 'node:net';
import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, resolve as pathResolve } from 'node:path';

import { daemonSocketPath } from '../lib/runtime-paths.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DAEMON_PATH = pathResolve(__dirname, 'copilot-acp-daemon.mjs');
const DAEMON_BOOT_TIMEOUT_MS = 8_000;
const REQUEST_TIMEOUT_MS = 6 * 60 * 1000;
const MAX_LONG_POLL_WAIT_SEC = 22 * 60;

// --- Socket I/O --------------------------------------------------------------

function sendToSocket(message, timeoutMs = REQUEST_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const sock = connectSocket(daemonSocketPath());
    let buf = '';
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error('client request timeout'));
    }, timeoutMs);

    sock.on('connect', () => {
      sock.write(JSON.stringify(message));
      sock.end(); // half-close: tells server we're done writing
    });
    sock.setEncoding('utf8');
    sock.on('data', (chunk) => (buf += chunk));
    sock.on('end', () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(buf.trim()));
      } catch (err) {
        reject(new Error(`invalid response from daemon: ${err.message}`));
      }
    });
    sock.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// --- Daemon lifecycle --------------------------------------------------------

async function isDaemonAlive() {
  try {
    const r = await sendToSocket({ command: 'status' });
    return r && r.ok === true;
  } catch {
    return false;
  }
}

async function spawnDaemon() {
  if (!existsSync(DAEMON_PATH)) {
    throw new Error(`daemon not found at ${DAEMON_PATH}`);
  }
  const child = spawn(process.execPath, [DAEMON_PATH], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  // Poll for socket availability
  const start = Date.now();
  while (Date.now() - start < DAEMON_BOOT_TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, 100));
    if (await isDaemonAlive()) return;
  }
  throw new Error('daemon failed to start within timeout');
}

async function ensureDaemon() {
  if (await isDaemonAlive()) return;
  await spawnDaemon();
}

// --- Subcommand handlers -----------------------------------------------------

// Background prompt: returns immediately with promptId. Use `watch` to poll
// progress and `cancel` to interrupt. --cwd is required so the daemon never
// falls back to the client's current directory. Optional --session <sid> to
// use an existing session; otherwise a new session is created.
async function cmdPromptBg(args) {
  const cwd = parseFlag(args, '--cwd');
  if (!cwd) throw new Error('usage: prompt-bg --cwd <absolute-path> [--session <sid>] <text>');
  if (!isAbsolute(cwd)) throw new Error(`--cwd must be absolute: ${cwd}`);
  try {
    if (!statSync(cwd).isDirectory()) throw new Error('not a directory');
  } catch (err) {
    throw new Error(`--cwd must exist as a directory: ${cwd}`);
  }
  const sessionId = parseFlag(args, '--session');
  const text = args
    .filter((a, i, arr) => {
      if (a === '--cwd' || a === '--session') return false;
      if (arr[i - 1] === '--cwd' || arr[i - 1] === '--session') return false;
      return true;
    })
    .join(' ');
  if (!text) throw new Error('usage: prompt-bg --cwd <absolute-path> [--session <sid>] <text>');
  await ensureDaemon();
  return sendToSocket({ command: 'prompt-bg', cwd, sessionId, text });
}

// Watch a background prompt. --since N starts from event line N (default 0).
// By default, consecutive thought/message chunks are coalesced into single
// events to reduce the size of the JSON response. Pass --raw to disable.
// Response includes new events, status, and the final summary if completed.
async function cmdWatch(args) {
  if (!(await isDaemonAlive())) throw new Error('daemon not running');
  const promptId = args[0];
  if (!promptId) {
    throw new Error('usage: watch <promptId> [--since <N>] [--raw] [--wait <sec>] [--summary-only]');
  }
  const since = parseInt(parseFlag(args, '--since') || '0', 10);
  const wait = parseInt(parseFlag(args, '--wait') || '0', 10);
  const summaryOnly = args.includes('--summary-only');
  const raw = args.includes('--raw');
  // When long-polling, extend the socket read deadline so the client doesn't
  // time out before the daemon resolves the waiter. Cap with the daemon's
  // MAX_LONG_POLL_WAIT_MS (22 min) plus a small socket-return grace window.
  const timeoutMs = wait > 0
    ? (Math.min(wait, MAX_LONG_POLL_WAIT_SEC) + 30) * 1000
    : REQUEST_TIMEOUT_MS;
  return sendToSocket({ command: 'watch', promptId, since, raw, wait, summaryOnly }, timeoutMs);
}

async function cmdInspect(args) {
  if (!(await isDaemonAlive())) throw new Error('daemon not running');
  const promptId = args[0];
  if (!promptId) throw new Error('usage: inspect <promptId> [--limit <N>]');
  const limit = parseInt(parseFlag(args, '--limit') || '40', 10);
  return sendToSocket({ command: 'inspect', promptId, includeTimeline: true, limit });
}

// `await <promptId> [--max-wait <sec>]` is sugar for the long-poll +
// summary-only path. The agent-bridge MCP server uses this from its
// internal worker so it never has to manage polling, offsets, or coalescing.
async function cmdAwait(args) {
  if (!(await isDaemonAlive())) throw new Error('daemon not running');
  const promptId = args[0];
  if (!promptId) throw new Error('usage: await <promptId> [--max-wait <sec>]');
  const maxWait = parseInt(parseFlag(args, '--max-wait') || '480', 10);
  const timeoutMs = (Math.min(maxWait, MAX_LONG_POLL_WAIT_SEC) + 30) * 1000;
  return sendToSocket(
    { command: 'watch', promptId, since: 0, raw: false, wait: maxWait, summaryOnly: true },
    timeoutMs,
  );
}

async function cmdCancel(args) {
  if (!(await isDaemonAlive())) throw new Error('daemon not running');
  const promptId = args[0];
  if (!promptId) throw new Error('usage: cancel <promptId>');
  return sendToSocket({ command: 'cancel', promptId });
}

async function cmdForget(args) {
  if (!(await isDaemonAlive())) throw new Error('daemon not running');
  const promptId = args[0];
  if (!promptId) throw new Error('usage: forget <promptId>');
  return sendToSocket({ command: 'forget', promptId });
}

async function cmdStatus() {
  if (!(await isDaemonAlive())) {
    return { ok: true, data: { connected: false, daemon: 'not-running' } };
  }
  return sendToSocket({ command: 'status' });
}

async function cmdStop() {
  if (!(await isDaemonAlive())) return { ok: true, data: { stopped: false, reason: 'not-running' } };
  return sendToSocket({ command: 'stop' });
}

// --- CLI dispatch ------------------------------------------------------------

function parseFlag(args, flag) {
  const idx = args.indexOf(flag);
  if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
  return null;
}

async function main() {
  const [, , subcommand, ...rest] = process.argv;
  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    console.log(
      'usage:\n' +
        '  copilot-acp-client.mjs prompt-bg --cwd <absolute-path> [--session <sid>] <text...>\n' +
        '  copilot-acp-client.mjs watch <promptId> [--since <N>] [--raw] [--wait <sec>] [--summary-only]\n' +
        '  copilot-acp-client.mjs inspect <promptId> [--limit <N>]\n' +
        '  copilot-acp-client.mjs await <promptId> [--max-wait <sec>]\n' +
        '  copilot-acp-client.mjs cancel <promptId>\n' +
        '  copilot-acp-client.mjs forget <promptId>\n' +
        '  copilot-acp-client.mjs status\n' +
        '  copilot-acp-client.mjs stop',
    );
    process.exit(0);
  }

  try {
    let result;
    switch (subcommand) {
      case 'prompt-bg': result = await cmdPromptBg(rest); break;
      case 'watch': result = await cmdWatch(rest); break;
      case 'inspect': result = await cmdInspect(rest); break;
      case 'await': result = await cmdAwait(rest); break;
      case 'cancel': result = await cmdCancel(rest); break;
      case 'forget': result = await cmdForget(rest); break;
      case 'status': result = await cmdStatus(); break;
      case 'stop': result = await cmdStop(); break;
      default:
        console.error(`unknown subcommand: ${subcommand}`);
        process.exit(1);
    }
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exit(result.ok ? 0 : 1);
  } catch (err) {
    process.stdout.write(JSON.stringify({ ok: false, error: err.message }) + '\n');
    process.exit(1);
  }
}

main();
