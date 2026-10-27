// Preload before the bridge entry point so its static and dynamic SDK imports
// resolve from plugin data without modifying Codex's trusted plugin bundle.
import { register } from 'node:module';

register('./resolve-codex-deps.mjs', import.meta.url);
