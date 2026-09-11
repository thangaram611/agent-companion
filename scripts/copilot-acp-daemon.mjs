#!/usr/bin/env node
// copilot-acp-daemon.mjs
// The Copilot binding of the generic ACP daemon (scripts/acp-daemon.mjs): the
// same classes, bound to the Copilot descriptor in lib/target-registry.mjs,
// whose `acp` block carries everything Copilot-shaped — the yolo flags, the
// OTEL usage exporter, the process-local sessions, the rubber-duck footer.
//
// The bridge spawns `scripts/acp-daemon.mjs --companion copilot`; running this
// file directly starts the identical daemon by hand. Its exports exist so the
// Copilot daemon suite (scripts/copilot-acp-daemon.test.mjs) keeps pinning the
// Copilot behaviours against a `SessionManager` that needs no arguments.

import {
  AcpConnection,
  IpcServer,
  SessionManager as AcpSessionManager,
  TERMINAL_STATUSES,
  REPLY_DRAIN_TIMEOUT_MS,
  resolveDescriptor,
  runDaemon,
  isMainModule,
} from './acp-daemon.mjs';

const COPILOT = resolveDescriptor('copilot');

class SessionManager extends AcpSessionManager {
  constructor() {
    super(COPILOT);
  }
}

export {
  SessionManager,
  AcpConnection,
  IpcServer,
  TERMINAL_STATUSES,
  REPLY_DRAIN_TIMEOUT_MS,
};

if (isMainModule(import.meta.url)) runDaemon(COPILOT);
