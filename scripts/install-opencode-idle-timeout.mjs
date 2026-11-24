#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { HOSTS } from '../lib/hosts/index.mjs';

const args = process.argv.slice(2);
const check = args[0] === '--check';
if (check) args.shift();
const [arg] = args;
// OpenCode 2.3.2 uses Effect's number-and-unit duration strings.
const duration = /^-?\d+(?:\.\d+)?\s+(?:nanos?|micros?|millis?|seconds?|minutes?|hours?|days?|weeks?)$/;
if (args.length !== 1 || !['default', 'false', 'Infinity', '-Infinity'].includes(arg) && !duration.test(arg)) {
  console.error('--opencode-idle-timeout takes an OpenCode duration (e.g. "8 hours"), false or default');
  process.exit(2);
}
if (check) process.exit(0); // Setup validates before installing dependencies.

const { parseTree, createScanner, SyntaxKind } = createRequire(new URL('../bridge-server/package.json', import.meta.url))('jsonc-parser');
const key = 'location_idle_timeout';
const value = arg === 'false' ? false : arg;
const end = node => node.offset + node.length;

function property(object, name) {
  if (object.type !== 'object') throw new Error('expected a configuration object');
  const matches = object.children.filter(p => p.children[0].value === name);
  if (matches.length > 1) throw new Error('duplicate property: ' + name);
  return matches[0];
}

// Remove the member and one separator. A whole-object serialization or the
// JSONC library's property deletion would also erase neighboring comments.
function removeMember(text, member) {
  const scanner = createScanner(text, true);
  scanner.setPosition(end(member));
  const trailing = scanner.scan() === SyntaxKind.CommaToken;
  const comma = scanner.getTokenOffset();
  let start = member.offset;
  let stop = end(member);
  // Retain comments between the key, colon, value and comma as well.
  const trivia = text.slice(start, stop).includes('/') || trailing && text.slice(stop, comma).includes('/');
  if (trivia) {
    scanner.setPosition(start);
    let cleaned = '', pos = start;
    const limit = trailing ? comma + 1 : stop;
    while (scanner.scan() !== SyntaxKind.EOF && scanner.getTokenOffset() < limit) {
      cleaned += text.slice(pos, scanner.getTokenOffset());
      pos = scanner.getPosition();
    }
    text = text.slice(0, start) + cleaned + text.slice(limit);
  } else {
    if (trailing) stop = comma + 1;
    const line = text.lastIndexOf('\n', start - 1) + 1;
    const eol = /^[ \t]*\r?\n/.exec(text.slice(stop));
    if (eol && /^[ \t]*$/.test(text.slice(line, start))) {
      start = line;
      stop += eol[0].length;
    }
    text = text.slice(0, start) + text.slice(stop);
  }
  const previous = member.parent.children[member.parent.children.indexOf(member) - 1];
  if (!trailing && previous) {
    scanner.setPosition(end(previous));
    scanner.scan();
    const separator = scanner.getTokenOffset();
    text = text.slice(0, separator) + text.slice(separator + 1);
  }
  return text;
}

function edit(text) {
  const errors = [];
  const root = parseTree(text, errors, { allowTrailingComma: true, allowEmptyContent: true });
  if (errors.length) throw new Error('invalid JSONC at offset ' + errors[0].offset);
  if (!root) return arg === 'default' ? text : text + (text && !text.endsWith('\n') ? '\n' : '') +
    JSON.stringify({ experimental: { [key]: value } }, null, 2) + '\n';
  const experimental = property(root, 'experimental')?.children[1];
  const member = experimental && property(experimental, key);
  if (arg === 'default') return member ? removeMember(text, member) : text;
  if (member) {
    const old = member.children[1];
    return text.slice(0, old.offset) + JSON.stringify(value) + text.slice(end(old));
  }
  // Insert first so comments attached to existing members stay with them.
  const parent = experimental ?? root;
  const multiline = text.slice(parent.offset, end(parent)).includes('\n') || !parent.children.length;
  let pos = parent.offset + 1;
  const schema = !experimental && parent.children[0]?.children[0].value === '$schema';
  if (schema) {
    const last = end(parent.children[0]);
    const scanner = createScanner(text, true);
    scanner.setPosition(last);
    if (scanner.scan() === SyntaxKind.CommaToken) pos = scanner.getPosition();
    else {
      text = text.slice(0, last) + ',' + text.slice(last);
      pos = last + 1;
    }
    // A comment on the separator's line belongs to the schema. Leave the
    // following lines (including comments introducing the next key) intact.
    const inline = /^(?:[ \t]*(?:\/\/[^\r\n]*|\/\*[\s\S]*?\*\/))*/.exec(text.slice(pos))[0];
    if (parent.children.length === 1 || /^[ \t]*[\r\n]/.test(text.slice(pos + inline.length))) pos += inline.length;
  }
  const unit = text.match(/^([ \t]+)"/m)?.[1] ?? '  ';
  const base = text.slice(text.lastIndexOf('\n', parent.offset - 1) + 1, parent.offset).match(/^[ \t]*/)[0];
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  const indent = base + unit;
  const entry = experimental ? JSON.stringify(value) : JSON.stringify({ [key]: value }, null, multiline ? unit : 0).replaceAll('\n', nl + indent);
  const prefix = multiline ? nl + indent : '';
  const suffix = parent.children.length > (schema ? 1 : 0) ? ',' : '';
  const close = multiline && text[pos] === '}' ? nl + base : '';
  return text.slice(0, pos) + prefix + JSON.stringify(experimental ? key : 'experimental') + ': ' + entry + suffix + close + text.slice(pos);
}

try {
  const dir = HOSTS.opencode.configDir();
  const jsonc = join(dir, 'opencode.jsonc');
  const existing = [join(dir, 'opencode.json'), jsonc].filter(existsSync);
  // .jsonc takes precedence over .json. On default remove both overrides.
  const files = arg === 'default' ? existing : [existing.at(-1) ?? jsonc];
  const changes = files.map(file => {
    const source = existsSync(file) ? readFileSync(file, 'utf8') : '';
    return { file, source, edited: edit(source) };
  });
  for (const { file, source, edited } of changes) {
    if (edited === source) continue;
    const path = existsSync(file) ? realpathSync(file) : file;
    const mode = existsSync(path) ? statSync(path).mode & 0o777 : 0o600;
    mkdirSync(dirname(path), { recursive: true });
    const temp = path + '.' + randomUUID() + '.tmp';
    try {
      writeFileSync(temp, edited, { flag: 'wx', mode: 0o600 });
      chmodSync(temp, mode);
      renameSync(temp, path);
    } finally { rmSync(temp, { force: true }); }
    console.log(arg === 'default' ? `Removed experimental.${key} from ${file}` : `Set experimental.${key} to ${JSON.stringify(value)} in ${file}`);
  }
} catch (err) {
  console.error('Could not edit global OpenCode config: ' + err.message);
  process.exitCode = 1;
}
