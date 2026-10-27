import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const bridgeRoot = new URL('../bridge-server/', import.meta.url).href;
const dependencyParent = pathToFileURL(join(process.env.PLUGIN_DATA, 'bridge-server', 'package.json')).href;

export function resolve(specifier, context, nextResolve) {
  // Only the bridge's scoped SDK imports need relocation. Relative source
  // imports, built-ins, and the SDKs' own dependency graphs resolve normally,
  // retaining Node's ESM export conditions.
  if (context.parentURL?.startsWith(bridgeRoot) && specifier.startsWith('@')) {
    return nextResolve(specifier, { ...context, parentURL: dependencyParent });
  }
  return nextResolve(specifier, context);
}
