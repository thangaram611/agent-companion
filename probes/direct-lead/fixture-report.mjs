import { createHash } from 'node:crypto';

export function report(kb) {
  const lines = [];
  let size = 0;
  for (let i = 1; size < kb * 1024; i++) {
    const line = `Line ${String(i).padStart(5, '0')}: the companion found item ${i * 7919 % 10007} in module ${i % 37} and cites file src/part${i % 91}.ts:${i % 400 + 1}.`;
    lines.push(line); size += line.length + 1;
  }
  const body = lines.join('\n');
  return `${body}\nEND sha256=${createHash('sha256').update(body).digest('hex')} lines=${lines.length} bytes=${body.length}`;
}
