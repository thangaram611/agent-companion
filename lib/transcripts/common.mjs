// Shared normalization only; companion-specific meanings stay in their readers.
export function text(content) {
  if (typeof content === 'string') return content;
  return (content ?? []).map(part => typeof part === 'string' ? part : part.text ?? '').join('\n');
}
export function output(value = '', nativeTruncated = false) {
  const bytes = Buffer.from(text(value));
  let end = Math.min(bytes.length, 64 * 1024);
  // Do not split a UTF-8 code point or let a replacement character exceed the cap.
  if (end < bytes.length) while ((bytes[end] & 0xc0) === 0x80) end--;
  return { output: bytes.subarray(0, end).toString(), ...(end < bytes.length || nativeTruncated ? { truncated: true } : {}) };
}
export function status(value) {
  return ({ running: 'running', streaming: 'streaming', completed: 'completed', failed: 'failed', error: 'failed' })[value] ?? null;
}
export function exitCode(value) { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
