// Guard test for the shipped Copilot reviewer agent artifact.
//
// setup.sh copies .copilot/agents/reviewer.agent.md into ~/.copilot/agents/
// on a Copilot install. That file declares a `model:` in its YAML frontmatter,
// and the Copilot CLI consumes it directly. The model must therefore be a
// documented Copilot model id — i.e. a member of ALLOWED_MODELS (the
// Copilot-side catalog in lib/state.mjs). This mirrors the Codex-side guard in
// templates/agent-companion.toml.test.mjs, which asserts the Codex subagent's
// role model is in CODEX_AGENT_MODELS. Without this, the allow-list and the
// shipped reviewer artifact can silently drift apart (as they did when
// ALLOWED_MODELS was narrowed to the documented Copilot catalog).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const reviewerPath = join(here, '..', '.copilot', 'agents', 'reviewer.agent.md');

test('Copilot reviewer agent declares a model id in ALLOWED_MODELS', async () => {
  const raw = readFileSync(reviewerPath, 'utf8');
  const match = raw.match(/^model:\s*(\S+)\s*$/m);
  assert.ok(match, 'reviewer.agent.md declares a top-level model: field');

  const { ALLOWED_MODELS, isModelAllowed } = await import('./state.mjs');
  assert.equal(
    isModelAllowed(match[1]),
    true,
    `reviewer model "${match[1]}" must be a documented Copilot id in ALLOWED_MODELS ` +
      `(${[...ALLOWED_MODELS].join(', ')})`,
  );
});
