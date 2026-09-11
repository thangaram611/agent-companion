// Runtime adapter boundary for the ACP companions (Copilot, Gemini).
//
// Every method takes the companion it addresses and routes to that companion's
// daemon socket (daemon-client.mjs). Copilot alone has a second transport, the
// experimental SDK adapter behind COPILOT_RUNTIME_ADAPTER=sdk; this module
// isolates the bridge from both shapes so server.mjs speaks one vocabulary.
// Copilot stays the default argument so the pre-existing call sites read as
// they always did.

import { ensureDaemon, sendToSocket } from './daemon-client.mjs';
import { DEFAULT_ACP_COMPANION } from '../lib/runtime-paths.mjs';

export const RUNTIME_ADAPTERS = new Set(['acp', 'sdk']);
export const DEFAULT_RUNTIME_ADAPTER = 'acp';

let sdkRuntimePromise = null;
let sdkRuntimeOverride = null;

export function selectedRuntimeAdapter() {
  return ((process.env.COPILOT_RUNTIME_ADAPTER || DEFAULT_RUNTIME_ADAPTER).trim() || DEFAULT_RUNTIME_ADAPTER).toLowerCase();
}

// Whether a job on this companion can be reattached by a respawned bridge.
// The daemons are detached by construction; only Copilot's SDK adapter is not.
export function runtimeSupportsDetachedPromptResume(companion = DEFAULT_ACP_COMPANION) {
  if (companion !== DEFAULT_ACP_COMPANION) return true;
  return assertSupportedAdapter() === 'acp';
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

async function roundTrip(message, timeoutMs, companion = DEFAULT_ACP_COMPANION) {
  const adapter = companion === DEFAULT_ACP_COMPANION ? assertSupportedAdapter() : 'acp';
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
  return sendToSocket(message, timeoutMs, companion);
}

export async function ensureRuntime({ reqId, companion = DEFAULT_ACP_COMPANION } = {}) {
  const adapter = companion === DEFAULT_ACP_COMPANION ? assertSupportedAdapter() : 'acp';
  if (adapter === 'sdk') {
    const sdk = await sdkRuntime();
    return sdk.ensureRuntime({ reqId });
  }
  return ensureDaemon({ reqId, companion });
}

export function runtimeStatus(timeoutMs, companion = DEFAULT_ACP_COMPANION) {
  return roundTrip({ command: 'status' }, timeoutMs, companion);
}

export function promptBg({ sessionId = null, text, cwd, model, reqId, companion = DEFAULT_ACP_COMPANION }) {
  return roundTrip({
    command: 'prompt-bg',
    sessionId,
    text,
    cwd,
    model,
    reqId,
  }, undefined, companion);
}

export function watchPrompt({ promptId, since = 0, raw = false, wait = 0, summaryOnly = false, companion = DEFAULT_ACP_COMPANION }, timeoutMs) {
  return roundTrip({
    command: 'watch',
    promptId,
    since,
    raw,
    wait,
    summaryOnly,
  }, timeoutMs, companion);
}

export function inspectPrompt({ promptId, includeTimeline = false, limit = 40, companion = DEFAULT_ACP_COMPANION }, timeoutMs = 15_000) {
  return roundTrip({
    command: 'inspect',
    promptId,
    includeTimeline,
    limit,
  }, timeoutMs, companion);
}

export function cancelPrompt({ promptId, companion = DEFAULT_ACP_COMPANION }) {
  return roundTrip({ command: 'cancel', promptId }, undefined, companion);
}

export function replyPrompt({ promptId, message, companion = DEFAULT_ACP_COMPANION }, timeoutMs = 15_000) {
  return roundTrip({ command: 'reply', promptId, message }, timeoutMs, companion);
}

export function _setSdkRuntimeForTest(runtime) {
  sdkRuntimeOverride = runtime;
}

export function _resetSdkRuntimeForTest() {
  sdkRuntimeOverride = null;
  sdkRuntimePromise = null;
}
