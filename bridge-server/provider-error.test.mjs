import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendProviderError } from './provider-error.mjs';

test('the provider message is appended once, after the answer', () => {
  assert.equal(appendProviderError('answer', new Error('HTTP 429')), 'answer\n\nHTTP 429');
  assert.equal(appendProviderError('', new Error('HTTP 429')), 'HTTP 429');
  assert.equal(appendProviderError('HTTP 429', new Error('HTTP 429')), 'HTTP 429');
});

// Measured on Copilot 1.0.112: an in-turn 429 arrives as reply text
// "Error: <message>" while events.jsonl records the same message in session.error.
test('a reply that already carries the provider message is not repeated', () => {
  const message = 'Failed to get response from the AI model; retried 5 times (total retry wait time: 5.00 seconds) Last error: 429 FIXTURE overloaded: HTTP 429';
  assert.equal(appendProviderError(`Error: ${message}`, message), `Error: ${message}`);
});
