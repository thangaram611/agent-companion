import { SANDBOX_HOME } from '../test/sandbox-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

function fixture() {
  const dir = mkdtempSync(join(SANDBOX_HOME, 'idle-'));
  const config = join(dir, 'opencode');
  mkdirSync(config);
  const script = join(import.meta.dirname, 'install-opencode-idle-timeout.mjs');
  const run = (...args) => spawnSync(process.execPath, [script, ...args], {
    env: { HOME: SANDBOX_HOME, XDG_CONFIG_HOME: dir }, encoding: 'utf8',
  });
  return { run, json: join(config, 'opencode.json'), jsonc: join(config, 'opencode.jsonc') };
}

test('validates OpenCode durations and special values before writing', () => {
  const { run, jsonc } = fixture();
  for (const v of ['false', 'default', '8 hours', '90 minutes', '0 millis', '1.25 days', '1 week']) {
    assert.equal(run('--check', v).status, 0, v);
  }
  for (const args of [[], [''], ['true'], ['8'], ['8h'], ['1 fortnight'], ['false', 'extra']]) {
    assert.equal(run(...args).status, 2, String(args));
  }
  assert.equal(existsSync(jsonc), false);
});

test('creates the global document on set and leaves a missing default alone', () => {
  const { run, jsonc } = fixture();
  assert.equal(run('default').status, 0);
  assert.equal(existsSync(jsonc), false);
  for (const [arg, expected] of [['8 hours', '8 hours'], ['false', false], ['default', undefined]]) {
    const r = run(arg);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(readFileSync(jsonc, 'utf8')).experimental?.location_idle_timeout, expected);
  }
});

test('edits the effective file and removes overrides from both global documents', () => {
  const { run, json, jsonc } = fixture();
  const plain = '{"experimental":{"location_idle_timeout":false,"other":3}}\n';
  writeFileSync(json, plain);
  assert.equal(run('90 minutes').status, 0);
  assert.equal(readFileSync(json, 'utf8'), plain.replace('false', '"90 minutes"'));
  assert.equal(existsSync(jsonc), false);
  const original = '{\r\n\t// keep this layout\r\n\t"experimental": {\r\n\t\t/* keep */ "other" : 3,\r\n\t\t// timeout\r\n\t\t"location_idle_timeout" : "1 hour",\r\n\t},\r\n}\r\n';
  writeFileSync(jsonc, original);
  for (let i = 0; i < 2; i++) {
    assert.equal(run('false').status, 0);
    assert.equal(readFileSync(jsonc, 'utf8'), original.replace('"1 hour"', 'false'));
  }
  assert.ok(readFileSync(json, 'utf8').includes('"90 minutes"'));
  assert.equal(run('default').status, 0);
  assert.equal(readFileSync(jsonc, 'utf8'), original.replace('\t\t"location_idle_timeout" : "1 hour",\r\n', ''));
  assert.deepEqual(JSON.parse(readFileSync(json, 'utf8')), { experimental: { other: 3 } });
});

test('insertion preserves comments, indentation and unrelated values', () => {
  const { run, jsonc } = fixture();
  const original = '{\n\t// model for this user\n\t"model" : "a/b"\n}\n';
  writeFileSync(jsonc, original);
  assert.equal(run('false').status, 0);
  const edited = readFileSync(jsonc, 'utf8');
  assert.ok(edited.includes('\n\t\t"location_idle_timeout": false'));
  assert.ok(edited.endsWith(original.slice(1)));
  const nested = '{ "experimental": { /* preserve this */ "other": 3 } }';
  writeFileSync(jsonc, nested);
  assert.equal(run('90 minutes').status, 0);
  assert.ok(readFileSync(jsonc, 'utf8').includes('/* preserve this */ "other": 3'));
});

test('removing the last or only member preserves comments around its separators', () => {
  const { run, jsonc } = fixture();
  for (const sibling of ['', '"keep": true /* previous */ ,']) {
    for (const comma of ['', ',']) {
      const original = '{"experimental":{' + sibling + '"location_idle_timeout" /* key */ : false /* value */ ' + comma + '}}';
      writeFileSync(jsonc, original);
      const r = run('default');
      assert.equal(r.status, 0, r.stderr);
      const edited = readFileSync(jsonc, 'utf8');
      assert.ok(edited.includes('/* key */') && edited.includes('/* value */'));
      if (sibling) assert.ok(edited.includes('"keep": true /* previous */'));
      assert.doesNotMatch(edited, /location_idle_timeout/);
      // A second pass must still parse the result and leave it byte-identical.
      assert.equal(run('default').status, 0);
      assert.equal(readFileSync(jsonc, 'utf8'), edited);
    }
  }
});

test('malformed global config survives a failed edit', () => {
  const { run, jsonc } = fixture();
  for (const invalid of ['{"experimental":', '{"experimental":"unexpected"}']) {
    writeFileSync(jsonc, invalid);
    assert.equal(run('false').status, 1);
    assert.equal(readFileSync(jsonc, 'utf8'), invalid);
  }
});

test('S21 inserts after a leading schema and keeps adjacent JSONC comments', () => {
  const { run, jsonc } = fixture();
  const before = '{\n  // schema docs\n  "$schema": "schema.json", // schema note\n';
  const after = '  // model docs\n  "model": "a/b"\n}\n';
  writeFileSync(jsonc, before + after);
  const r = run('false');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(jsonc, 'utf8'), before +
    '  "experimental": {\n    "location_idle_timeout": false\n  },\n' + after);
});
