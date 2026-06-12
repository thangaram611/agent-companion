// Runtime adapter boundary for bridge-server.
//
// The ACP daemon remains the production default. This module isolates the
// bridge from daemon-client's raw socket command shape so the Copilot SDK can
// be introduced behind the same methods without touching server.mjs.

import { ensureDaemon, sendToSocket } from './daemon-client.mjs';

export const RUNTIME_ADAPTERS = new Set(['acp', 'sdk']);
export const DEFAULT_RUNTIME_ADAPTER = 'acp';

let sdkRuntimePromise = null;
let sdkRuntimeOverride = null;

export function selectedRuntimeAdapter() {
  return ((process.env.COPILOT_RUNTIME_ADAPTER || DEFAULT_RUNTIME_ADAPTER).trim() || DEFAULT_RUNTIME_ADAPTER).toLowerCase();
}

function assertSupportedAdapter() {
  const adapter = selectedRuntimeAdapter();
  if (RUNTIME_ADAPTERS.has(adapter)) return adapter;
  const err = new Error(
    `unsupported Copilot runtime adapter "${adapter}". ` +
    'Supported adapters: acp, sdk. ACP remains the default until SDK parity checks pass.',
  );
  err.code = 'RUNTIME_ADAPTER_UNSUPPORTED';
  err.adapter = adapter;
  throw err;
}

async function sdkRuntime() {
  if (sdkRuntimeOverride) return sdkRuntimeOverride;
  if (!sdkRuntimePromise) sdkRuntimePromise = import('./copilot-sdk-runtime.mjs');
  return sdkRuntimePromise;
}

async function roundTrip(message, timeoutMs) {
  const adapter = assertSupportedAdapter();
  if (adapter === 'sdk') {
    const sdk = await sdkRuntime();
    switch (message.command) {
      case 'status':
        return sdk.runtimeStatus(timeoutMs);
      case 'prompt-bg':
        return sdk.promptBg(message);
      case 'watch':
        return sdk.watchPrompt(message, timeoutMs);
      case 'inspect':
        return sdk.inspectPrompt(message, timeoutMs);
      case 'cancel':
        return sdk.cancelPrompt(message);
      case 'reply':
        return sdk.replyPrompt(message, timeoutMs);
      default:
        return { ok: false, error: `unknown sdk runtime command: ${message.command}` };
    }
  }
  return sendToSocket(message, timeoutMs);
}

export async function ensureRuntime(opts = {}) {
  const adapter = assertSupportedAdapter();
  if (adapter === 'sdk') {
    const sdk = await sdkRuntime();
    return sdk.ensureRuntime(opts);
  }
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

export function _setSdkRuntimeForTest(runtime) {
  sdkRuntimeOverride = runtime;
}

export function _resetSdkRuntimeForTest() {
  sdkRuntimeOverride = null;
  sdkRuntimePromise = null;
}
