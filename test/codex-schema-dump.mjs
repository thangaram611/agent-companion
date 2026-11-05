import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexAppServerContract } from '../lib/codex-app-server-contract.mjs';

export function pinnedSchemaDump() {
  const contract = codexAppServerContract();
  const dir = mkdtempSync(join(tmpdir(), 'codex-pinned-schema-'));
  test.after(() => rmSync(dir, { recursive: true, force: true }));
  const definitions = {};
  const ref = (name) => ({ $ref: `#/definitions/${name}` });
  function fieldSchema(tag) {
    tag = tag.replace(/\?$/, '');
    if (tag.endsWith('[]')) return { type: 'array', items: fieldSchema(tag.slice(0, -2)) };
    if (tag.startsWith('enum:')) return { type: 'string', enum: tag.slice(5).split('|') };
    if (tag === 'any') return {};
    if (/^[A-Z]/.test(tag)) {
      definitions[tag] ??= { type: 'object' };
      return ref(tag);
    }
    return { type: tag };
  }
  function shape(fields) {
    if (typeof fields === 'string') return fieldSchema(fields);
    if (Array.isArray(fields)) return { oneOf: fields.map(shape) };
    return {
      type: 'object',
      properties: Object.fromEntries(Object.entries(fields).map(([key, tag]) => [key, fieldSchema(tag)])),
      required: Object.keys(fields).filter((key) => !fields[key].endsWith('?')),
    };
  }
  const write = (name, schema) => writeFileSync(join(dir, `${name}.json`), JSON.stringify(schema));
  const method = (name, params, paramsRequired = true) => ({
    type: 'object',
    properties: { method: { type: 'string', enum: [name] }, ...(params ? { params } : {}) },
    required: ['method', ...(paramsRequired ? ['params'] : [])],
  });
  for (const [name, fields] of Object.entries(contract.structuredTypes)) definitions[name] = shape(fields);
  definitions.ThreadItem = { oneOf: Object.values(contract.threadItems).map(shape) };
  definitions.ThreadActiveFlag = { type: 'string', enum: contract.threadActiveFlags };
  definitions.ThreadId = { type: 'string' };
  const notifications = contract.serverNotifications.map((entry) =>
    method(entry.method, entry.params ? shape(entry.params) : null));
  const requests = contract.serverRequests.map((entry, index) => {
    const name = `Request${index}`;
    const key = entry.key?.split('.')[1];
    definitions[`${name}Params`] = {
      type: 'object', properties: key ? { [key]: ref('ThreadId') } : {},
      required: key && !entry.optional ? [key] : [],
    };
    const decision = contract.approvalDecisions[entry.method];
    write(`${name}Response`, decision
      ? shape({ [decision.field]: `enum:${decision.decisions.join('|')}` })
      : shape({}));
    return method(entry.method, ref(`${name}Params`));
  });
  write('ClientRequest', {
    oneOf: contract.clientRequests.map((entry) => method(entry.method,
      shape(Object.fromEntries(entry.required.map((key) => [key, 'any']))), entry.paramsRequired)),
  });
  write('ServerNotification', { oneOf: notifications, definitions });
  write('ServerRequest', { oneOf: requests, definitions });
  return dir;
}
