// Read only message strings, never provider data, headers or response bodies.
function providerErrorMessage(error) {
  let message = '';
  const seen = new Set();
  for (let current = error; current && !seen.has(current); current = current.cause) {
    seen.add(current);
    const value = typeof current === 'string' ? current : current.message;
    if (typeof value === 'string' && value.trim()) message = value;
  }
  const line = message.replace(/\s+/g, ' ').trim();
  return line.length > 500 ? line.slice(0, 499) + '…' : line;
}

export function appendProviderError(text = '', error) {
  const message = providerErrorMessage(error);
  if (!message || text.trim() === message) return text;
  return text ? `${text}\n\n${message}` : message;
}
