import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const home = env => env.HOME || homedir();
const sessionPath = lead => '/api/session/' + encodeURIComponent(lead.session);

function serviceParent(env) {
  // The service publishes its PID in this home's state file. Private servers
  // also inherit the home, but their bridge has a different parent.
  const state = env.XDG_STATE_HOME || join(home(env), '.local/state');
  try { return JSON.parse(readFileSync(join(state, 'opencode/service.json'), 'utf8')).pid === process.ppid; }
  catch { return false; }
}

async function api(env, method, path, body) {
  const args = ['api', method, path];
  if (body !== undefined) args.push('--data', JSON.stringify(body));
  try {
    const { stdout } = await run('opencode', args, { env, timeout: 10000, killSignal: 'SIGKILL' });
    return stdout.trim() ? JSON.parse(stdout) : null;
  } catch (err) {
    // execFile errors include the complete argv (including the wake notice).
    throw new Error(`OpenCode ${method} failed (${err.signal || err.code || 'invalid response'})`);
  }
}

async function sessionInfo(lead, env) {
  const info = (await api(env, 'GET', sessionPath(lead)))?.data;
  if (info?.id !== lead.session) throw new Error('OpenCode session unavailable');
  return info;
}

export const opencode = {
  id: 'opencode',
  displayName: 'OpenCode',
  configDir: (env = process.env) => join(env.XDG_CONFIG_HOME || join(home(env), '.config'), 'opencode'),
  pluginDataDir: (_env, root) => root,
  settingsName: 'opencode.json',
  bridgePerSession: false,
  oldAgentFile: null,
  toolPrefix: 'agent-bridge_',
  startupWake: true,
  leadFromCall({ meta }) {
    const session = meta?.['ai.opencode/sessionID'];
    if (typeof session !== 'string' || !session.trim() || /[{}]/.test(session)) return null;
    return { host: this.id, session, agent: null };
  },
  async wakeStatus(lead, env, startup = false) {
    if (serviceParent(env)) {
      try {
        const info = await sessionInfo(lead, env);
        if (info.parentID) return { wake: null, reason: 'subagent' };
        // State is shared by every directory bridge. Only the lead's own
        // directory restores its wake after startup.
        if (!startup || info.location?.directory === process.cwd()) return { wake: 'opencode_prompt', reason: null };
      } catch { /* service or session gone */ }
    }
    return { wake: null, reason: 'private_server' };
  },
  async wake(lead, notice, env, startup) {
    if ((await this.wakeStatus(lead, env, startup)).wake) {
      await api(env, 'POST', sessionPath(lead) + '/prompt', { text: notice });
    }
  },
};
