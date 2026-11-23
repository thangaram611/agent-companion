import { createHmac, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { writePrivateFileAtomic } from '../private-files.mjs';
import { runtimeRoot } from './runtime.mjs';
import { noticeRequest, registeredSessions } from './copilot-notice.mjs';

const configDir = (env = process.env) => env.COPILOT_HOME || join(env.HOME || homedir(), '.copilot');
const validId = id => typeof id === 'string' && /^[\w.-]+$/.test(id) && id !== '.' && id !== '..';

export function hookIdentity({ sessionId, agentId, parentAgentId }) {
  if (!validId(sessionId)) return null;
  if (agentId === undefined && parentAgentId === undefined) return { session: sessionId, agent: null };
  if (agentId !== sessionId || !validId(parentAgentId) || parentAgentId === agentId) return null;
  return { session: sessionId, agent: agentId };
}

// A native pre-tool hook and the bridge share this private key. A caller that
// bypasses the hook cannot make an argument look like host-provided identity.
function proof(lead, call, env, create) {
  const dir = runtimeRoot(copilot, env);
  const file = join(dir, 'hook.key');
  let key;
  try { key = readFileSync(file); }
  catch (err) {
    if (err.code !== 'ENOENT' || !create) throw err;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { writePrivateFileAtomic(file, randomBytes(32), { replace: false }); }
    catch (err) { if (err.code !== 'EEXIST') throw err; }
    key = readFileSync(file);
  }
  return createHmac('sha256', key).update(JSON.stringify([call, lead.session, lead.agent])).digest('hex');
}

export function stampLead(data, env) {
  const lead = hookIdentity(data);
  if (!lead || !data.toolCallId) return null;
  return { ...lead, proof: proof(lead, data.toolCallId, env, true) };
}

export const copilot = {
  id: 'copilot',
  displayName: 'GitHub Copilot CLI',
  configDir,
  pluginDataDir: env => join(configDir(env), 'agent-companion/deps'),
  settingsName: 'settings.json',
  bridgePerSession: true,
  oldAgentFile: null,
  toolPrefix: 'agent-bridge-',
  leadFromCall({ args, meta, env }) {
    const session = env?.COPILOT_AGENT_SESSION_ID;
    const lead = args?.lead;
    const call = meta?.['com.github.copilot/toolCallId'];
    if (!validId(session) || !validId(lead?.session) || typeof call !== 'string' || !call) return null;
    if (lead.agent === null ? lead.session !== session : lead.agent !== lead.session || lead.agent === session) return null;
    try {
      if (proof(lead, call, env, false) === lead.proof) return { host: this.id, session, agent: lead.agent };
    } catch { /* missing proof */ }
    return null;
  },
  async wakeStatus(lead, env) {
    if (lead.agent !== null) return { wake: null, reason: 'subagent' };
    if (lead.session === env.COPILOT_AGENT_SESSION_ID) {
      try {
        await noticeRequest(runtimeRoot(this, env), lead.session);
        return { wake: 'copilot_session_send', reason: null };
      } catch { /* not joined or no longer accepting */ }
    }
    return { wake: null, reason: 'extension_unavailable' };
  },
  async wake(lead, notice, env) {
    if (lead.agent === null && lead.session === env.COPILOT_AGENT_SESSION_ID) {
      await noticeRequest(runtimeRoot(this, env), lead.session, notice);
    }
  },
  async diagnostics(env) {
    let settings;
    try { settings = JSON.parse(readFileSync(join(configDir(env), this.settingsName), 'utf8')); }
    catch { /* no readable settings */ }
    const experimental = settings?.experimental === true;
    const registrations = await registeredSessions(runtimeRoot(this, env), env.COPILOT_AGENT_SESSION_ID);
    const extensionMode = settings?.extensions?.mode ?? 'load_and_augment';
    const disabledExtensions = settings?.extensions?.disabledExtensions ?? [];
    return { experimental, extensionMode, disabledExtensions, registrations, detail: 'experimental ' + (experimental ? 'on' : 'off')
      + ', extensions ' + extensionMode + ', ' + registrations + ' live notice extension(s)'
      + (disabledExtensions.length ? ' (disabled: ' + disabledExtensions.join(', ') + ')' : '') };
  },
};
