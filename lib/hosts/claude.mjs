import { runtimeRoot } from './runtime.mjs';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { once } from 'node:events';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const claude = {
  id: 'claude',
  displayName: 'Claude Code',
  configDir: (env = process.env) => join(env.HOME || homedir(), '.claude'),
  pluginDataDir: (env, root) => env.CLAUDE_PLUGIN_DATA || env.PLUGIN_DATA || join(root, '.plugin-data'),
  settingsName: 'settings.json',
  leadFromCall({ args }) {
    const { session, agent = null } = args.lead ?? {};
    if (typeof session !== 'string' || !session.trim() || session.includes('${') || session.includes('}')) return null;
    if (agent !== null && (typeof agent !== 'string' || !agent.trim())) return null;
    return { host: this.id, session, agent };
  },
  sessionFile(env) {
    const socket = env.CLAUDE_CODE_MESSAGING_SOCKET;
    if (!socket) return null;
    return join(runtimeRoot(this, env), 'sessions', createHash('sha256').update(socket).digest('hex') + '.json');
  },
  wakeStatus(lead, env) {
    if (lead.agent !== null) return { wake: null, reason: 'subagent' };
    const file = this.sessionFile(env);
    if (!file) return { wake: null, reason: 'missing_socket' };
    if (!env.CLAUDE_CODE_MESSAGING_TOKEN) return { wake: null, reason: 'missing_token' };
    try {
      const current = JSON.parse(readFileSync(file, 'utf8'));
      if (current.session === lead.session && current.socket === env.CLAUDE_CODE_MESSAGING_SOCKET) {
        return { wake: 'inbox_socket', reason: null };
      }
      return { wake: null, reason: 'session_changed' };
    } catch { return { wake: null, reason: 'session_unregistered' }; }
  },
  async wake(lead, notice, env) {
    if (!this.wakeStatus(lead, env).wake) return;
    const socket = createConnection(env.CLAUDE_CODE_MESSAGING_SOCKET);
    socket.setTimeout(10000, () => socket.destroy(new Error('inbox socket timed out')));
    try {
      await once(socket, 'connect');
      // /clear can reuse the same socket while a connection is opening.
      if (!this.wakeStatus(lead, env).wake) return;
      const auth = { type: 'auth', token: env.CLAUDE_CODE_MESSAGING_TOKEN };
      const message = { type: 'user', message: { role: 'user', content: notice } };
      socket.end(JSON.stringify(auth) + '\n' + JSON.stringify(message) + '\n');
      await once(socket, 'finish');
    } finally { socket.destroy(); }
  },
  toolPrefix: 'mcp__plugin_agent-companion_agent-bridge__',
};
