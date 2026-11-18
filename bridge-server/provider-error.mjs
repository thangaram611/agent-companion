// Read only message strings, never provider data, headers or response bodies.
function providerErrorMessage(error) {
  // The bridge's model refusal includes the full session option list. Its
  // JSON-RPC cause supplies diagnostics but can omit every available id.
  if (error?.code === 'MODEL_NOT_ALLOWED' && error.cause && typeof error.message === 'string' && error.message !== error.code) {
    return error.message.replace(/\s+/g, ' ').trim();
  }
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
  // Copilot streams "Error: <message>" as reply text; do not repeat it.
  if (!message || text.includes(message)) return text;
  return text ? `${text}\n\n${message}` : message;
}
