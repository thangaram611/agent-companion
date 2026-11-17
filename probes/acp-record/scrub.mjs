// Capture-only transformations. Never feed these values back to the live agent.
// Semantic ids (model, config, mode, permission option) are protocol vocabulary.
const opaqueId = /^(session|tool_?call|thread|turn|message|request|terminal|trace|span)_?id$/i;
const secret = /gh[pousr]_|github_pat_|\bsk-|Bearer\s+/i;

export function createScrubber({ paths = [], forbidden = [] } = {}) {
  const replacements = paths.filter(([path]) => path).sort((a, b) => b[0].length - a[0].length);
  const ids = new Map();
  const renumber = (kind, value) => {
    if (value == null) return value;
    if (!ids.has(kind)) ids.set(kind, new Map());
    const values = ids.get(kind);
    if (!values.has(value)) values.set(value, typeof value === 'number' ? values.size + 1 : `${kind}-${values.size + 1}`);
    return values.get(value);
  };
  const replacePaths = value => {
    for (const [from, to] of replacements) value = value.replaceAll(from, to);
    return value;
  };
  const walk = value => {
    if (typeof value === 'string') return replacePaths(value);
    if (Array.isArray(value)) return value.map(walk);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      const kind = opaqueId.exec(key)?.[1].toLowerCase().replaceAll('_', '');
      return [replacePaths(key), kind && ['string', 'number'].includes(typeof item) ? renumber(kind, item) : walk(item)];
    }));
  };
  return value => {
    // Check before normalizing ids too: a credential used as an id must not
    // disappear into the id map and quietly turn a bad capture into a good one.
    if (secret.test(JSON.stringify(value))) throw new Error('Refusing ACP capture: token-like text');
    const clean = walk(value);
    if (value.frame?.id != null) {
      const requester = value.frame.method ? value.dir : value.dir === 'agent' ? 'client' : 'agent';
      clean.frame.id = renumber(`rpc-${requester}`, value.frame.id);
    }
    const serialized = JSON.stringify(clean);
    if (secret.test(serialized) || forbidden.some(part => part && serialized.includes(part))) {
      throw new Error('Refusing ACP capture: private text remains after scrubbing');
    }
    return clean;
  };
}
