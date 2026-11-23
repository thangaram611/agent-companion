import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

function configDir(env = process.env) {
  const configured = String(env.CODEX_HOME || '').trim();
  return configured ? resolve(configured) : join(env.HOME || homedir(), '.codex');
}

export const codex = {
  id: 'codex',
  displayName: 'Codex',
  configDir,
  pluginDataDir: env => env.PLUGIN_DATA || join(configDir(env), 'plugins/data/agent-companion-agent-companion'),
  settingsName: 'config.toml',
  toolPrefix: 'mcp__agent_bridge__',
};
