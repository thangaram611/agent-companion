#!/usr/bin/env node

// Synchronous doctor calls cannot await the Unix-socket probe in-process.
// Keep the async boundary in this tiny child and always emit one JSON object;
// an absent broker is healthy cold-start state, not a failing probe process.

import { probeCodexBrokerHealth } from '../bridge-server/codex-app-server-runtime.mjs';

const health = await probeCodexBrokerHealth();
process.stdout.write(`${JSON.stringify(health)}\n`);
