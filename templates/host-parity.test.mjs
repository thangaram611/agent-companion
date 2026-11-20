// Host parity: the two templates must offer the END USER the same thing.
//
// agent-companion is a host-neutral bridge, not a Claude plugin that happens to
// run elsewhere. The matrix is {claude, codex} hosts x {opencode, copilot,
// codex, antigravity, claude} companions, and a capability that exists on one host and not the other
// is a bug in the product, not a detail of the port.
//
// The two templates configure the same bridge through different host
// mechanisms, so they cannot be compared line by line:
//
//   Claude  .claude-plugin/plugin.json      native plugin MCP declaration,
//                                           per-server `timeout:` in MILLISECONDS
//   Codex   .codex-plugin/plugin.json       native plugin MCP declaration,
//                                           `tool_timeout_sec` in SECONDS
//
// MECHANISM may diverge; CAPABILITY may not. This file asserts the second half.
// Each template's own suite (agent-companion.md.test.mjs,
// agent-companion.toml.test.mjs) owns the first.
//
// Historical origin (retired survival design): the app-server adapter shipped documented in the Claude
// template only. Nothing compared the pair, so a codex-host operator would have
// silently kept the transport whose jobs die with the bridge — the exact defect
// the adapter was built to fix, present or absent depending on which host you
// launched from.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const md = readFileSync(join(HERE, 'agent-companion.md'), 'utf8');
const toml = readFileSync(join(HERE, 'agent-companion.toml'), 'utf8');
const claudeManifest = JSON.parse(readFileSync(join(HERE, '..', '.claude-plugin', 'plugin.json'), 'utf8'));
const codexManifest = JSON.parse(readFileSync(
  join(HERE, '..', '.codex-plugin', 'plugin.json'),
  'utf8',
));

// Keys that name WHICH host the file is, so they cannot have a twin by
// construction. Everything else in an env block is a capability knob.
const HOST_IDENTITY_KEYS = new Set(['AGENT_COMPANION_HOST']);

// Both hosts now configure the session-scoped server in their plugin manifest.
function claudeEnv() {
  return claudeManifest.mcpServers?.['agent-bridge']?.env || {};
}

// Current Codex roles cannot add MCP authority. The operative Codex env is
// therefore the plugin-scoped native MCP declaration that the role inherits.
function codexEnv() {
  return codexManifest.mcpServers?.['agent-bridge']?.env || {};
}

const capabilityKeys = (env) => Object.keys(env).filter((k) => !HOST_IDENTITY_KEYS.has(k)).sort();

test('both hosts ship the same capability knobs, with the same values', () => {
  const claude = claudeEnv();
  const codex = codexEnv();

  assert.deepEqual(capabilityKeys(claude), [],
    'Neither host sets a capability knob; adding one means adding it to both');
  assert.deepEqual(capabilityKeys(claude), capabilityKeys(codex),
    'a knob set for one host and not the other gives the two an unequal feature set — '
    + 'set it in both templates, or neither');

  for (const key of capabilityKeys(claude)) {
    assert.equal(claude[key], codex[key],
      `${key} differs between hosts (claude=${claude[key]} codex=${codex[key]}): `
      + 'the same dispatch would behave differently depending on which host launched the bridge');
  }
});

test('both hosts set the same effective tool deadline above the wait cap', () => {
  const timeout = claudeManifest.mcpServers['agent-bridge'].timeout;
  assert.equal(timeout, codexManifest.mcpServers['agent-bridge'].tool_timeout_sec * 1000);
  assert.ok(timeout > 1200 * 1000);
});

test('both hosts offer the same six private tools and conversational send fields', () => {
  const claude = md.slice(md.indexOf('\n---\n') + 5);
  const codex = toml.match(/^developer_instructions\s*=\s*"""([\s\S]*?)"""/m)[1];
  for (const body of [claude, codex]) {
    const names = [...new Set([...body.matchAll(/mcp__agent[-_]bridge__agent_([a-z]+)/g)].map((m) => m[1]))].sort();
    assert.deepEqual(names, ['cancel', 'catalog', 'reply', 'send', 'status', 'wait']);
    assert.match(body.replace(/\s+/g, ' '), /`task` and `cwd`, plus optional `target`, `model`, `effort` and `max_wait_sec`/);
    assert.doesNotMatch(body, /\b(?:templates?|strengths?|profiles?|verdicts?|fleet|parallel)\b/i);
  }
  assert.deepEqual([...claude.matchAll(/^# (.+)$/gm)].map((m) => m[1]),
    [...codex.matchAll(/^# (.+)$/gm)].map((m) => m[1]));
});

test('each plugin identifies its host for the shared launcher', () => {
  assert.equal(codexEnv().AGENT_COMPANION_HOST, 'codex');
  assert.equal(claudeEnv().AGENT_COMPANION_HOST, 'claude');
});

test('only Claude registers the PreToolUse failure policies', () => {
  const hooks = file => JSON.parse(readFileSync(join(HERE, '..', 'hooks', file), 'utf8')).hooks;
  assert.deepEqual(hooks('hooks.json').PreToolUse.flatMap(group => group.hooks.map(h => h.onFailure)), ['block', 'continue']);
  for (const groups of Object.values(hooks('hooks-codex.json'))) {
    for (const { hooks } of groups) assert.ok(hooks.every(h => !Object.hasOwn(h, 'onFailure')));
  }
});

test('both hosts describe the same five companions and Claude follow-up limits', () => {
  const claudeDescription = md.match(/^description: \|\n([\s\S]*?)^model:/m)[1];
  const codexDescription = toml.match(/^description\s*=\s*"""([\s\S]*?)"""/m)[1];
  const openings = [claudeDescription, codexDescription].map((text) =>
    text.replace(/\s+/g, ' ').trim().split('Tell it in plain language')[0]);
  assert.equal(openings[0], openings[1]);
  for (const companion of ['Codex', 'OpenCode', 'Antigravity', 'Copilot', 'Claude Code']) {
    assert.ok(openings[0].includes(companion), `${companion} must be offered on both hosts`);
  }
  const continuity = [md, toml].map((text) => text.match(/Every supported follow-up[\s\S]*?(?=\n# Waiting)/)[0]
    .replace(/\s+/g, ' ').trim());
  assert.equal(continuity[0], continuity[1]);
  assert.match(continuity[0], /Claude Code follow-ups resume saved conversations cold/);
  assert.match(continuity[0], /Codex and OpenCode default to steer; Claude Code and Antigravity default to queue/);
  assert.match(continuity[0], /Send every follow-up to the companion through `agent_send`/);
  assert.match(continuity[0], /A different companion is a new conversation/);
  assert.match(continuity[0], /Copilot supports cancel only/);
});

test('both roles offer the same invoker effort and launch transparency instructions', () => {
  for (const source of [md, toml]) {
    const prose = source.replace(/\s+/g, ' ');
    assert.match(prose, /Pass `model` and `effort` on `agent_send` only when named/);
    assert.match(prose, /When the job starts, relay `effective_model`, `selected_effort` and `permission_mode`/);
    assert.match(prose, /reporting a running job, relay `activity`/);
    assert.match(prose, /EFFORT_NOT_ALLOWED/);
  }
});

test('both roles relay authentication failures as setup problems without retry or substitution', () => {
  for (const source of [md, toml]) {
    assert.match(source, /For `AUTH_REQUIRED`, relay it as a setup problem with the sign-in steps; do not retry or switch companion\./);
  }
});


test('both roles relay the same work summary and full transcript pointer', () => {
  const rule = source => source.match(/When `meta.work_summary`[\s\S]*?(?=\n\n)/)?.[0];
  assert.ok(rule(md), 'Claude work summary relay rule');
  assert.ok(rule(toml), 'Codex work summary relay rule');
  assert.equal(rule(md), rule(toml));
});

test('both roles relay user notices, use the requested or default mode, and report undelivered input identically', () => {
  for (const start of ['When a wait returns `user_intervened`', 'For a reply, call', 'When `meta.interventions` is present']) {
    const rule = source => source.slice(source.indexOf(start)).split('\n\n')[0].replaceAll('mcp__agent-bridge__', 'mcp__agent_bridge__');
    assert.ok(md.includes(start)); assert.ok(toml.includes(start));
    assert.equal(rule(md), rule(toml));
  }
  for (const source of [md, toml]) {
    const prose = source.replace(/\s+/g, ' ');
    assert.match(prose, /`user_intervened`.*sender, mode, text and time.*one line, then keep waiting.*same `BUDGET`/);
    assert.match(prose, /notice of accepted input, never the companion's answer/);
    // Measured 2026-11-17: a subagent read a queued user message as an
    // instruction to itself and told the parent it was "leaving it out".
    assert.match(prose, /already gave it to the companion.*not an instruction to you.*Do not act on it, weigh it or leave it out/);
    assert.match(prose, /use the parent's requested `mode`, or omit `mode` for the companion's default/);
    assert.match(prose, /`reply_unavailable` and its reason \(`state` or `capability`\); never substitute another mode/);
    assert.match(prose, /`meta.interventions`.*every `not_delivered` message with its sender, mode and first line/);
    assert.doesNotMatch(prose, /reply_available|In-flight replies are only/);
  }
});
