// Runtime adapter boundary for bridge-server.
//
// The ACP daemon remains the production default. This module isolates the
// bridge from daemon-client's raw socket command shape so the Copilot SDK can
// be introduced behind the same methods without touching server.mjs.

import { ensureDaemon, sendToSocket } from './daemon-client.mjs';

export const RUNTIME_ADAPTERS = new Set(['acp']);
export const DEFAULT_RUNTIME_ADAPTER = 'acp';

export function selectedRuntimeAdapter() {
  return (process.env.COPILOT_RUNTIME_ADAPTER || DEFAULT_RUNTIME_ADAPTER).trim() || DEFAULT_RUNTIME_ADAPTER;
}

function assertSupportedAdapter() {
  const adapter = selectedRuntimeAdapter();
  if (RUNTIME_ADAPTERS.has(adapter)) return adapter;
  const err = new Error(
    `unsupported Copilot runtime adapter "${adapter}". ` +
    'Supported today: acp. The SDK adapter is intentionally not wired until it passes live parity checks.',
  );
  err.code = 'RUNTIME_ADAPTER_UNSUPPORTED';
  err.adapter = adapter;
  throw err;
}

async function roundTrip(message, timeoutMs) {
  assertSupportedAdapter();
  return sendToSocket(message, timeoutMs);
}

export async function ensureRuntime(opts = {}) {
  assertSupportedAdapter();
  return ensureDaemon(opts);
}

export function runtimeStatus(timeoutMs) {
  return roundTrip({ command: 'status' }, timeoutMs);
}

export function promptBg({ sessionId = null, text, cwd, model, reqId }) {
  return roundTrip({
    command: 'prompt-bg',
    sessionId,
    text,
    cwd,
    model,
    reqId,
  });
}

export function watchPrompt({ promptId, since = 0, raw = false, wait = 0, summaryOnly = false }, timeoutMs) {
  return roundTrip({
    command: 'watch',
    promptId,
    since,
    raw,
    wait,
    summaryOnly,
  }, timeoutMs);
}

export function inspectPrompt({ promptId, includeTimeline = false, limit = 40 }, timeoutMs = 15_000) {
  return roundTrip({
    command: 'inspect',
    promptId,
    includeTimeline,
    limit,
  }, timeoutMs);
}

export function cancelPrompt({ promptId }) {
  return roundTrip({ command: 'cancel', promptId });
}

export function replyPrompt({ promptId, message }, timeoutMs = 15_000) {
  return roundTrip({ command: 'reply', promptId, message }, timeoutMs);
}
