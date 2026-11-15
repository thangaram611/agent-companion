import { isBuiltin } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const bridgeRoot = new URL('../bridge-server/', import.meta.url).href;
const dependencyParent = pathToFileURL(join(process.env.PLUGIN_DATA, 'bridge-server', 'package.json')).href;

export function resolve(specifier, context, nextResolve) {
  // Package imports from the bridge and the UI under bridge-server/ (the MCP
  // SDK, ink, react) resolve from plugin data. Relative and URL imports,
  // built-ins, and the packages' own dependency graphs resolve normally,
  // retaining Node's ESM export conditions.
  if (context.parentURL?.startsWith(bridgeRoot) && /^[^./#][^:]*$/.test(specifier) && !isBuiltin(specifier)) {
    return nextResolve(specifier, { ...context, parentURL: dependencyParent });
  }
  return nextResolve(specifier, context);
}
