// Internal executable for record-copilot.mjs; _ACP_RECORD is private transport
// configuration, not an operator knob. No raw traffic is ever written to disk.
import { spawn } from 'node:child_process';
import { appendFileSync, rmSync, writeFileSync } from 'node:fs';
import { Transform } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { createScrubber } from './scrub.mjs';

const { binary, capture, header, paths, forbidden } = JSON.parse(process.env._ACP_RECORD);
const scrub = createScrubber({ paths, forbidden });
let child, failed = false;
function fail() {
  if (failed) return;
  failed = true;
  rmSync(capture, { force: true });
  process.stderr.write('ACP recorder: capture refused (private text, invalid JSON, or transport failure).\n');
  process.exitCode = 1;
  process.stdin.destroy();
  child?.kill('SIGTERM');
}

function tap(dir) {
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  const line = text => {
    if (!text.trim()) return;
    const row = scrub({ dir, frame: JSON.parse(text) });
    if (!failed) appendFileSync(capture, JSON.stringify(row) + '\n');
  };
  return new Transform({
    transform(chunk, encoding, done) {
      try {
        buffer += decoder.write(chunk);
        let at;
        while ((at = buffer.indexOf('\n')) !== -1) {
          line(buffer.slice(0, at)); buffer = buffer.slice(at + 1);
        }
        done(null, chunk); // Preserve the original bytes, including whitespace.
      } catch { fail(); done(); }
    },
    flush(done) {
      try { buffer += decoder.end(); if (buffer) line(buffer); done(); }
      catch { fail(); done(); }
    },
  });
}

try {
  writeFileSync(capture, JSON.stringify(scrub(header)) + '\n', { mode: 0o600, flag: 'wx' });
  const { _ACP_RECORD, ...env } = process.env;
  child = spawn(binary, process.argv.slice(2), { env, stdio: ['pipe', 'pipe', 'inherit'] });
  child.on('error', fail);
  child.stdin.on('error', fail);
  child.stdout.on('error', fail);
  process.stdin.on('error', fail);
  process.stdout.on('error', fail);
  process.stdin.pipe(tap('client')).pipe(child.stdin);
  child.stdout.pipe(tap('agent')).pipe(process.stdout);
  child.on('close', (code, signal) => {
    if (code !== 0 || signal) fail();
    process.stdin.destroy();
  });
} catch { fail(); }
