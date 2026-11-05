import { truncateChars, MAX_SUMMARY_CHARS } from '../../lib/text-utils.mjs';
import { usageFromOpenCodeInfo, sumUsage } from '../../lib/usage.mjs';

export function parseOpenCodeModel(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const slash = s.indexOf('/');
  if (slash <= 0 || slash === s.length - 1) return null;
  return { providerID: s.slice(0, slash), modelID: s.slice(slash + 1) };
}

// The env-default model (server uses its own configured default when unset).
export function createTurnAccumulator(sessionId) {
  let pending = '';
  // assistant message id -> { textParts: Map(partId->text), reasoning: Map, tools: Map }
  const messages = new Map();
  let latestAssistantId = null;
  let aborted = false;
  let messageError = null; // { name, message }
  let terminal = null; // { status }
  let sawEvent = false;

  function partText(map) {
    return [...map.values()].map((s) => String(s || '')).join('');
  }

  function snapshotMessage(id) {
    const m = messages.get(id);
    if (!m) return { text: '', thoughts: '' };
    return {
      text: partText(m.textParts),
      thoughts: partText(m.reasoning),
    };
  }

  const usageByMessage = new Map(); // messageID -> usage, latest info wins

  function ensureMessage(id) {
    if (!messages.has(id)) messages.set(id, { textParts: new Map(), reasoning: new Map(), tools: new Map() });
    return messages.get(id);
  }

  function onEvent(evt) {
    if (!evt || typeof evt !== 'object') return;
    const type = String(evt.type || '');
    if (evt.data && type.startsWith('session.')) {
      onV2Event(type, evt.data);
      return;
    }
    const props = evt.properties || {};
    // Global noise (no sessionID, or a different session) is ignored.
    const eventSession = props.sessionID || props.info?.sessionID || props.part?.sessionID;
    if (eventSession !== sessionId) return;
    sawEvent = true;

    if (type === 'message.updated') {
      const info = props.info || {};
      if (info.role === 'assistant') {
        latestAssistantId = info.id || latestAssistantId;
        if (info.id) ensureMessage(info.id);
        // OpenCode re-sends the info as the message completes, tokens and cost
        // filled in; the latest per message wins, and the turn is their sum.
        const usage = usageFromOpenCodeInfo(info, 'opencode-server');
        if (usage && info.id) usageByMessage.set(info.id, usage);
        if (info.error) {
          const name = info.error.name || info.error.type || 'error';
          messageError = { name, message: info.error.message || info.error.data?.message || name };
          if (/abort/i.test(name)) aborted = true;
        }
      }
      return;
    }

    if (type === 'message.part.updated') {
      const part = props.part || {};
      const mid = part.messageID;
      if (!mid) return;
      const m = ensureMessage(mid);
      // Any part (text/tool/reasoning) belongs to the assistant message, so a
      // tool-only or reasoning-only turn still resolves to the right snapshot.
      latestAssistantId = mid;
      if (part.id == null) return;
      if (part.type === 'text' && typeof part.text === 'string') {
        if (!part.synthetic && !part.ignored) m.textParts.set(part.id, part.text);
      } else if (part.type === 'reasoning' && typeof part.text === 'string') {
        m.reasoning.set(part.id, part.text);
      } else if (part.type === 'tool') {
        m.tools.set(part.id, {
          name: part.tool || part.name || 'tool',
          input: part.state?.input || part.input || {},
          status: part.state?.status || null,
        });
      }
      return;
    }

    if (type === 'session.error') {
      const err = props.error || {};
      const name = err.name || err.type || 'session.error';
      messageError = { name, message: err.message || err.data?.message || name };
      if (/abort/i.test(name)) aborted = true;
      terminal = { status: aborted ? 'cancelled' : 'failed' };
      return;
    }

    if (type === 'session.idle') {
      if (aborted || (messageError && /abort/i.test(messageError.name))) {
        terminal = { status: 'cancelled' };
      } else if (messageError) {
        terminal = { status: 'failed' };
      } else {
        terminal = { status: 'completed' };
      }
    }
  }

  function onV2Event(type, data) {
    if (data.sessionID !== sessionId) return;
    sawEvent = true;
    if (type.startsWith('session.execution.')) {
      const status = { succeeded: 'completed', interrupted: 'cancelled', failed: 'failed' }[type.split('.').at(-1)];
      if (status) {
        if (data.error) messageError = { name: data.error.type, message: data.error.message };
        terminal = { status };
      }
      return;
    }
    const id = data.assistantMessageID;
    if (!id) return;
    const message = ensureMessage(id);
    latestAssistantId = id;
    if (type === 'session.step.started') message.model = data.model?.id;
    if (type === 'session.step.ended') {
      const usage = usageFromOpenCodeInfo({ ...data, modelID: message.model }, 'opencode-server');
      if (usage) usageByMessage.set(id, usage);
      if (data.error) messageError = { name: data.error.type, message: data.error.message };
    }
    const textKind = type.match(/^session\.(text|reasoning)\.(delta|ended)$/);
    if (textKind) {
      const parts = textKind[1] === 'text' ? message.textParts : message.reasoning;
      const key = data.ordinal;
      parts.set(key, textKind[2] === 'ended' ? data.text : (parts.get(key) || '') + data.delta);
    }
    if (type === 'session.tool.input.started' || type === 'session.tool.called') {
      const tool = message.tools.get(data.id) || { name: data.name, input: {} };
      if (data.input) tool.input = data.input;
      message.tools.set(data.id, tool);
    }
  }

  return {
    // Feed raw SSE text; parses complete `\n\n`-delimited frames.
    push(text) {
      pending += text;
      let idx;
      while ((idx = pending.indexOf('\n\n')) !== -1) {
        const frame = pending.slice(0, idx);
        pending = pending.slice(idx + 2);
        consumeFrame(frame);
      }
    },
    // Flush a trailing partial frame (used on stream close).
    flush() {
      if (pending.trim()) consumeFrame(pending);
      pending = '';
    },
    get terminal() { return terminal; },
    get sawEvent() { return sawEvent; },
    snapshot() {
      const snap = latestAssistantId ? snapshotMessage(latestAssistantId) : { text: '', thoughts: '' };
      const out = {
        message: truncateChars(snap.text, MAX_SUMMARY_CHARS),
        thoughts: truncateChars(snap.thoughts, MAX_SUMMARY_CHARS),
        toolCalls: [...messages.values()].flatMap(m => [...m.tools.values()]).map(t => ({ name: t.name, input: t.input })),
        error: messageError ? messageError.message : null,
      };
      const usage = sumUsage([...usageByMessage.values()]);
      if (usage) out.usage = usage;
      return out;
    },
  };

  function consumeFrame(frame) {
    for (const line of frame.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const json = trimmed.slice(5).trim();
      if (!json) continue;
      let evt;
      try { evt = JSON.parse(json); } catch { continue; }
      onEvent(evt);
    }
  }
}

