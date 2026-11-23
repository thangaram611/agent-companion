#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { detectHost } from '../lib/hosts/index.mjs';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListResourceTemplatesRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pkg from './package.json' with { type: 'json' };
import { log } from './validation.mjs';
import { migrateDefaults } from '../lib/state.mjs';
import { defaultTargetId, listTargetIds } from '../lib/target-registry.mjs';
import { tools, dispatch, createBridgeController, recoverController, listDigestResources, listDigestResourceTemplates, readDigestResource } from './tools.mjs';

const controller = createBridgeController();
const isMain = (() => {
  try {
    const argvReal = realpathSync(process.argv[1]);
    const metaReal = realpathSync(fileURLToPath(import.meta.url));
    return argvReal === metaReal;
  } catch { return false; }
})();
if (isMain) {
  // A settings file the bridge cannot write leaves the old files for the next start.
  try { migrateDefaults({ log }); } catch (err) { log('WARN', `defaults migration skipped: ${err.message}`); }
}

export const mcp = new Server({ name: 'agent-bridge', version: pkg.version }, {
  capabilities: { tools: {}, resources: {} },
  instructions: 'Delegate work to a companion: for a second opinion or a review from another model, ' +
    'for independent work that can run in the background, or whenever the user names a companion. ' +
    'companion_send with the task and the absolute repo or worktree path (cwd) starts a thread and returns at once. ' +
    'The companion receives the task verbatim and sees nothing else of this conversation, so state the goal, what is known and what done looks like. ' +
    'Pass the returned thread to companion_send for a follow-up; new text on a running thread is an intervention (mode steer, queue or interrupt). ' +
    'You may end your turn: the result reaches you through the completion hook, or companion_wait blocks for it. ' +
    'companion_status with no arguments lists your threads; companion_cancel stops a job. ' +
    `Default companion: ${defaultTargetId() || 'unset'}. Supported companions: ${listTargetIds().join(', ')}.`,
});

mcp.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: listDigestResources(controller),
}));

mcp.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
  resourceTemplates: listDigestResourceTemplates(),
}));

mcp.setRequestHandler(ReadResourceRequestSchema, async (req) => (
  readDigestResource(req.params.uri, controller)
));

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map(({ name, description, inputSchema, annotations }) =>
    ({ name, description, inputSchema, annotations })),
}));
mcp.setRequestHandler(CallToolRequestSchema, (req, { requestId, signal } = {}) =>
  dispatch(req.params, { controller, requestId, signal }));

// Controller integration seam. Host loss never implements cleanup itself.
let bridgeLossHandler = async () => { log('WARN', 'bridge loss: no controller cleanup handler registered'); };
export function registerBridgeLossHandler(handler) {
  bridgeLossHandler = handler;
}
export async function onBridgeLoss() {
  await bridgeLossHandler();
}

registerBridgeLossHandler(() => controller.bridgeLost());

let bridgeLossPending = false;
async function exitOnBridgeLoss(code) {
  if (bridgeLossPending) return;
  bridgeLossPending = true;
  // EOF may remove the final active handle. Keep the process alive until the
  // async controller handoff finishes; subsequent signals share this exit.
  const keepAlive = setInterval(() => {}, 1000);
  try { await onBridgeLoss(); }
  catch (err) { log('ERROR', 'bridge loss handler failed:', err.message); }
  finally {
    clearInterval(keepAlive);
    process.exit(code);
  }
}

if (isMain) {
  process.on('SIGINT', () => { void exitOnBridgeLoss(130); });
  process.on('SIGTERM', () => { void exitOnBridgeLoss(143); });
  process.stdin.on('end', () => { void exitOnBridgeLoss(0); });
  await recoverController(controller);
  // One-line startup log so a user troubleshooting host routing can grep
  // the private runtime bridge log for "host detected" and see what the
  // bridge resolved on this run. The README's Diagnostics section points
  // readers here.
  log('INFO', `bridge.startup host_detected=${detectHost()}`);

  await mcp.connect(new StdioServerTransport());
}
