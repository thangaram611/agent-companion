import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const text = readFileSync(join(HERE, 'agent-companion.md'), 'utf8');

test('Claude template documents status response rendering explicitly', () => {
  assert.match(text, /Status envelope/);
  assert.match(text, /response has `action: "status"` and `ok: true`/);
  assert.match(text, /never emit `undefined`/);
  assert.match(text, /echo "\$CLAUDE_CODE_SESSION_ID"/);
  assert.match(text, /meta\.digest_uri/);
  assert.match(text, /resource_link/);
  assert.match(text, /"diagnostics": true/);
  assert.match(text, /MCP-native doctor report/);
  assert.doesNotMatch(text, /canonical place to look up structured per-job progress/);
});
