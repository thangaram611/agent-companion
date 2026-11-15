// Preload before the bridge or UI entry point so their static and dynamic package
// imports resolve from plugin data without modifying Codex's trusted plugin bundle.
import { register } from 'node:module';

register('./resolve-codex-deps.mjs', import.meta.url);
