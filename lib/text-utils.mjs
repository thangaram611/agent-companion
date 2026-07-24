export const MAX_SUMMARY_CHARS = 64 * 1024;

export function truncateChars(s, n) {
  const text = String(s || '');
  return text.length > n ? `${text.slice(0, n)}\n\n[truncated ${text.length - n} chars]` : text;
}

// Append `chunk` to `current`, keeping the result under `maxBytes` by
// trimming from the front (newest output wins). Shared by the single-shot
// CLI runtime adapters' stdout/stderr capture.
export function appendCapped(current, chunk, maxBytes) {
  const next = current + chunk;
  if (Buffer.byteLength(next, 'utf8') <= maxBytes) return next;
  return next.slice(Math.max(0, next.length - maxBytes));
}
