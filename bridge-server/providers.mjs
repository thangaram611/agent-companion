import { COMPANIONS } from '../lib/companion-registry.mjs';
import { codexProvider } from './adapters/codex.mjs';
import { claudeProvider } from './adapters/claude.mjs';
import { opencodeProvider } from './adapters/opencode.mjs';
import { acpProvider } from './adapters/acp.mjs';

const factories = {
  'app-server': codexProvider,
  'stream-json': claudeProvider,
  http: opencodeProvider,
  acp: (options, id) => acpProvider(id, options),
};

export function createProviders(env) {
  return Object.fromEntries(Object.values(COMPANIONS).map(({ id, runtime }) =>
    [id, factories[runtime.adapterKind]({ env }, id)]));
}
