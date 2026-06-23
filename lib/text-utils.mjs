export const MAX_SUMMARY_CHARS = 64 * 1024;

export function truncateChars(s, n) {
  const text = String(s || '');
  return text.length > n ? `${text.slice(0, n)}\n\n[truncated ${text.length - n} chars]` : text;
}
