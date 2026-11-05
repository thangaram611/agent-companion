export const ACP_PROTOCOL_VERSION = 1;
const SPAWN_INIT_TIMEOUT_MS = 30 * 1000;
const JSONRPC_METHOD_NOT_FOUND = -32601;

function extractOutputPreview(update) {
  const ro = update.rawOutput;
  if (typeof ro === 'string') return ro.slice(0, 300);
  if (typeof ro?.content === 'string') return ro.content.slice(0, 300);
  if (typeof ro?.message === 'string') return ro.message.slice(0, 300);
  const content = update.content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const entry of content) {
      const text = entry?.content?.text ?? entry?.text;
      if (typeof text === 'string') parts.push(text);
    }
    if (parts.length) return parts.join('\n').slice(0, 300);
  }
  if (ro && typeof ro === 'object') {
    try { return JSON.stringify(ro).slice(0, 300); } catch { return null; }
  }
  return null;
}

// The option the daemon picks when the agent asks for permission. The
// one-shot options, never the persistent ones: the daemon answers for THIS
// call and does not write policy into the agent's own store.
function choosePermissionOption(options, allow) {
  const list = Array.isArray(options) ? options : [];
  const wanted = allow ? ['allow_once', 'allow_always'] : ['reject_once', 'reject_always'];
  for (const kind of wanted) {
    const option = list.find((o) => o?.kind === kind && o?.optionId != null);
    if (option) return option;
  }
  return null;
}

// --- AcpConnection -----------------------------------------------------------

export class AcpConnection {
  constructor(descriptor) {
    if (!descriptor?.acp) throw new Error('AcpConnection needs an ACP companion descriptor');
    this.descriptor = descriptor;
    this.companion = descriptor.id;
    this.log = () => {};
    this.child = null;
    this.requestId = 0;
    this.pendingRequests = new Map(); // id -> { resolve, reject, timer }
    this.sessionCollectors = new Map(); // sessionId -> { events, resolve, reject, timer }
    this.buffer = '';
    this.initialized = false;
    this.dead = false;
    // What the handshake established: the version the agent answered, and
    // whether it is the one this daemon pins.
    this.protocol = { pinned: ACP_PROTOCOL_VERSION, answered: null, status: 'pending' };
    this.agentInfo = null;
    this.agentCapabilities = null;
    // `session/update` kinds seen that the descriptor does not declare —
    // logged once each as drift, then parsed generically like the rest.
    this._undeclaredKinds = new Set();
    this._declaredKinds = new Set(descriptor.acp.updates || []);
  }

  isAlive() {
    return this.child !== null && !this.dead && this.child.exitCode === null;
  }

  _onStdoutData(chunk) {
    this.buffer += chunk;
    let nl;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (line) this._onLine(line);
    }
  }

  _onLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (err) {
      this.log('WARN', `non-json line from ${this.companion}:`, line.slice(0, 200));
      return;
    }

    // Response to a request (has id, has result/error)
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const pending = this.pendingRequests.get(msg.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(msg.id);
        if (msg.error) pending.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else pending.resolve(msg.result);
      }
      return;
    }

    // A request FROM the agent (has id and method): a client method it wants
    // this daemon to serve. Every one gets an answer — an unanswered request
    // is an agent that waits forever.
    if (msg.id !== undefined && msg.method) {
      this._onAgentRequest(msg);
      return;
    }

    // Notification (has method, no id)
    if (msg.method) {
      this._onNotification(msg);
    }
  }

  // The client methods the agent may call. `session/request_permission` is
  // the only one this daemon serves — it declared no fs and no terminal
  // capability, so a request for those is answered "Method not found" rather
  // than left hanging (an agent that asks anyway falls back to its own file
  // system, as Gemini CLI 0.59.0 was measured to do).
  _onAgentRequest(msg) {
    if (msg.method === 'session/request_permission') {
      this._answerPermission(msg);
      return;
    }
    this.log('WARN', `agent requested undeclared client method ${msg.method}; answering -32601`);
    this._sendResponse(msg.id, null, {
      code: JSONRPC_METHOD_NOT_FOUND,
      message: `Method not found: ${msg.method} (this client declared no such capability)`,
    });
  }

  // The daemon is the user. Answer from the descriptor's policy — `all`
  // allows every kind, `edit` allows tool calls of kind `edit`, `none` allows
  // nothing that asks — and leave a `permission` event on the prompt stream
  // so the digest and the operator can see what was decided and why.
  _answerPermission(msg) {
    const params = msg.params || {};
    const toolCall = params.toolCall || {};
    const policy = this.descriptor.acp.permission(process.env);
    const kind = toolCall.kind ?? null;
    const allow = policy === 'all' || (policy === 'edit' && kind === 'edit');
    const option = choosePermissionOption(params.options, allow);
    const decision = allow ? 'allow' : 'reject';
    const event = {
      type: 'permission',
      toolCallId: toolCall.toolCallId ?? null,
      title: toolCall.title ?? null,
      kind,
      policy,
      decision,
      optionId: option?.optionId ?? null,
    };
    this.log('INFO', 'permission request:', `session=${params.sessionId} tool=${toolCall.title || toolCall.toolCallId || '?'} kind=${kind} policy=${policy} -> ${decision}${option ? ` (${option.optionId})` : ' (no matching option; cancelled)'}`);
    const collector = this.sessionCollectors.get(params.sessionId);
    if (collector?.onEvent) {
      try { collector.onEvent(event); } catch (err) { this.log('WARN', 'onEvent callback failed:', err.message); }
    }
    const outcome = option
      ? { outcome: 'selected', optionId: option.optionId }
      : { outcome: 'cancelled' };
    this._sendResponse(msg.id, { outcome });
  }

  _sendResponse(id, result, error = null) {
    if (!this.isAlive()) return;
    const payload = error ? { jsonrpc: '2.0', id, error } : { jsonrpc: '2.0', id, result };
    try { this.child.stdin.write(JSON.stringify(payload) + '\n'); }
    catch (err) { this.log('WARN', 'failed to answer agent request:', err.message); }
  }

  _onNotification(msg) {
    if (msg.method === 'session/update') {
      const params = msg.params || {};
      const sessionId = params.sessionId;
      const update = params.update || {};
      const kind = update.sessionUpdate;
      if (kind && !this._declaredKinds.has(kind) && !this._undeclaredKinds.has(kind)) {
        this._undeclaredKinds.add(kind);
        this.log('WARN', `session/update kind '${kind}' not declared by the ${this.companion} descriptor (acp.updates) — parsed generically; if the agent changed, update lib/target-registry.mjs`);
      }
      const collector = this.sessionCollectors.get(sessionId);
      if (!collector) return;

      let streamEvent = null;

      switch (kind) {
        case 'agent_thought_chunk': {
          const text = update.content?.text || update.text || '';
          if (text) {
            collector.events.thoughtChunks.push(text);
            streamEvent = { type: 'thought', text };
          }
          break;
        }
        case 'agent_message_chunk': {
          const text = update.content?.text || update.text || '';
          if (text) {
            // When a thought/tool_call/plan interrupts the message stream,
            // Copilot's next message chunk arrives with no leading
            // whitespace, producing run-ons like "critique.The command..."
            // across the interruption. Insert a paragraph break at that
            // boundary — but skip if the prior chunk already ended with one.
            if (collector._messageNeedsBreak) {
              const last = collector.events.messageChunks.at(-1);
              if (typeof last !== 'string' || !/\n\s*$/.test(last)) {
                collector.events.messageChunks.push('\n\n');
              }
              collector._messageNeedsBreak = false;
            }
            collector.events.messageChunks.push(text);
            streamEvent = { type: 'message', text };
          }
          break;
        }
        case 'plan': {
          // ACP plan update — the agent's strategy for the turn. Useful for
          // surfacing high-level intent to the user during long turns.
          const entries = update.entries || update.plan || [];
          if (Array.isArray(entries) && entries.length > 0) {
            collector.events.plans.push(entries);
            streamEvent = { type: 'plan', entries };
          }
          break;
        }
        case 'tool_call': {
          const tc = {
            toolCallId: update.toolCallId,
            name: update.title || update.kind || 'unknown',
            kind: update.kind || null,
            locations: update.locations || null,
            input: update.rawInput || null,
            status: update.status || 'pending',
            output: null,
          };
          collector.events.toolCalls.push(tc);
          streamEvent = {
            type: 'tool_call',
            toolCallId: tc.toolCallId,
            name: tc.name,
            kind: tc.kind,
            locations: tc.locations,
            input: tc.input,
          };
          break;
        }
        case 'tool_call_update': {
          const tc = collector.events.toolCalls.find((t) => t.toolCallId === update.toolCallId);
          if (tc) {
            tc.status = update.status || tc.status;
            if (update.locations) tc.locations = update.locations;
            if (update.rawOutput !== undefined) tc.output = update.rawOutput;
            else if (update.content) tc.output = update.content;
          }
          const outputPreview = extractOutputPreview(update);
          if (update.status === 'failed') {
            this.log('DEBUG', 'tool_call failed:', tc?.name || update.toolCallId, outputPreview ? `— ${outputPreview.slice(0, 120)}` : '(no error detail)');
          }
          streamEvent = {
            type: 'tool_call_update',
            toolCallId: update.toolCallId,
            status: update.status,
            outputPreview,
            name: tc?.name ?? null,
            kind: tc?.kind ?? null,
          };
          break;
        }
      }

      // Non-message events arriving after at least one message chunk mark
      // the stream as needing a paragraph break on the next resumption.
      // See the agent_message_chunk case for consumption.
      if (streamEvent && streamEvent.type !== 'message' && collector.events.messageChunks.length > 0) {
        collector._messageNeedsBreak = true;
      }

      if (streamEvent && collector.onEvent) {
        try {
          collector.onEvent(streamEvent);
        } catch (err) {
          this.log('WARN', 'onEvent callback failed:', err.message);
        }
      }
    }
  }

  _failAll(reason) {
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pendingRequests.clear();
    for (const [sid, collector] of this.sessionCollectors) {
      clearTimeout(collector.timer);
      collector.reject(new Error(reason));
    }
    this.sessionCollectors.clear();
  }

  _sendRequest(method, params, timeoutMs = 60_000) {
    if (!this.isAlive()) return Promise.reject(new Error(`${this.companion} connection is not alive`));
    const id = ++this.requestId;
    const payload = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`request timeout (method=${method})`));
      }, timeoutMs);
      this.pendingRequests.set(id, { resolve, reject, timer });
      try {
        this.child.stdin.write(JSON.stringify(payload) + '\n');
      } catch (err) {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        reject(err);
      }
    });
  }

  _sendNotification(method, params) {
    if (!this.isAlive()) throw new Error(`${this.companion} connection is not alive`);
    const payload = { jsonrpc: '2.0', method, params };
    this.child.stdin.write(JSON.stringify(payload) + '\n');
  }

  // The v1 handshake. `clientCapabilities` is the spec's key (`capabilities`
  // was an MCP-ism); no fs and no terminal, so the agent uses its own file
  // system and shell. ACP has no `initialized` notification — the one the
  // Copilot daemon used to send was MCP's, and Gemini CLI 0.59.0 answered it
  // with a -32601 on stderr (measured 2026-09-11).
  async initialize() {
    const result = await this._sendRequest(
      'initialize',
      {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: this.descriptor.acp.clientName, version: '1.0.0' },
      },
      SPAWN_INIT_TIMEOUT_MS,
    );
    const answered = result?.protocolVersion ?? null;
    this.agentInfo = result?.agentInfo || null;
    this.agentCapabilities = result?.agentCapabilities || result?.capabilities || null;
    if (answered !== ACP_PROTOCOL_VERSION) {
      this.protocol = { pinned: ACP_PROTOCOL_VERSION, answered, status: 'mismatch' };
      const err = new Error(
        `${this.descriptor.displayName} answered protocolVersion ${answered === null ? '(none)' : answered}; `
        + `this daemon pins ${ACP_PROTOCOL_VERSION} and does not adapt (agent: ${this.agentInfo?.name || '?'} ${this.agentInfo?.version || ''})`.trim(),
      );
      err.code = 'ACP_PROTOCOL_MISMATCH';
      err.answered = answered;
      this.log('FATAL', 'protocol mismatch:', err.message);
      this.kill();
      throw err;
    }
    this.protocol = { pinned: ACP_PROTOCOL_VERSION, answered, status: 'match' };
    this.log('INFO', 'initialize ok:', {
      agentInfo: this.agentInfo,
      agentCapabilities: this.agentCapabilities,
    });
    this.initialized = true;
    return result;
  }

  async createSession(cwd) {
    const result = await this._sendRequest('session/new', { cwd, mcpServers: [] }, SPAWN_INIT_TIMEOUT_MS);
    this.log('INFO', 'session/new ok:', { sessionId: result?.sessionId });
    await this._applySessionModel(result.sessionId);
    return result.sessionId;
  }

  // The model, where the agent takes it per session rather than as a spawn
  // flag — the descriptor's `acp.setModel` names the request (Antigravity's
  // `session/set_config_option`, measured 2026-09-11 on agy_acp_server 1.1.1).
  // Sent after `session/new` AND after `session/load`, because a loaded
  // session comes back on the agent's default model (measured). No pin, or
  // no hook, sends nothing. An agent that refuses the id (-32602, naming the
  // ids it has) fails the session and the prompt with it: never a silent
  // fallback to the default.
  async _applySessionModel(sessionId) {
    const setModel = this.descriptor.acp.setModel;
    if (typeof setModel !== 'function' || !this.model) return;
    const [method, params] = setModel({ sessionId, model: this.model });
    await this._sendRequest(method, params, SPAWN_INIT_TIMEOUT_MS);
    this.log('INFO', `${method} ok:`, { sessionId, model: this.model });
  }

  // `session/load`: the agent replays the session's history as
  // `session/update` notifications and answers only when it is done. Nothing
  // collects for this session yet, so the replay is dropped on the floor —
  // which is exactly right: it is history, not this prompt's output.
  async loadSession(sessionId, cwd) {
    const result = await this._sendRequest('session/load', { sessionId, cwd, mcpServers: [] }, SPAWN_INIT_TIMEOUT_MS);
    this.log('INFO', 'session/load ok:', { sessionId });
    await this._applySessionModel(sessionId);
    return result;
  }

  // Send ACP session/cancel notification. The agent should abort the in-flight
  // turn and the prompt request will resolve with stopReason "cancelled".
  cancelSession(sessionId) {
    try {
      this._sendNotification('session/cancel', { sessionId });
      return true;
    } catch (err) {
      this.log('WARN', 'session/cancel failed:', err.message);
      return false;
    }
  }

  kill() {
    this.dead = true;
    this._failAll('connection killed');
  }
}
