import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

test('all Node floor declarations agree with bridge-server engines.node', () => {
  const required = JSON.parse(read('bridge-server/package.json')).engines.node;
  assert.equal(required, '>=26');
  const major = required.match(/^>=(\d+)$/)[1];
  assert.equal(JSON.parse(read('bridge-server/package-lock.json')).packages[''].engines.node, required);
  const sites = [
    ['hooks/node-tools.sh', /major < (\d+)/g],
    ['hooks/node-tools.sh', /Node\.js (\d+) or newer/g],
    ['setup.sh', /-lt (\d+)/g],
    ['lib/doctor.mjs', /ok: major >= (\d+)/g],
    ['lib/doctor.mjs', /required: '>=(\d+)'/g],
    ['lib/doctor.mjs', /Node\.js (\d+) or newer/g],
    ['README.md', /Node\.js `>= (\d+)`/g],
    ['.github/workflows/ci.yml', /node-version: (\d+)/g],
    ['docs/RELEASE_READINESS.md', /CI runs on Ubuntu with Node (\d+)/g],
    ['docs/RELEASE_READINESS.md', /Require the green Node (\d+) baseline/g],
  ];
  for (const [file, pattern] of sites) {
    const matches = [...read(file).matchAll(pattern)];
    assert.ok(matches.length, `${file}: missing floor declaration ${pattern}`);
    for (const match of matches) assert.equal(match[1], major, `${file}: ${match[0]}`);
  }
  for (const file of ['setup.sh', 'hooks/launch-agent-bridge.sh', 'hooks/install-deps.sh']) {
    assert.match(read(file), /node_requirement_error/, `${file} must use the shared refusal`);
    assert.doesNotMatch(read(file), /Node\.js.*(?:required|or newer)/, `${file} must not duplicate the refusal`);
  }
});
