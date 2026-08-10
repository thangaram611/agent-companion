// Minimal codex app-server BROKER prototype.
//
// Owns ONE `codex app-server` over stdio (the stable transport) and exposes a
// unix socket. Short-lived bridge processes connect, speak plain JSON-RPC, and
// disconnect; the app-server and its threads outlive them.
//
// Multiplexing: each client gets its own id space. The broker rewrites request
// ids on the way down and restores them on the way up. Notifications and
// server->client requests are broadcast to every connected client (a real
// implementation would route by threadId subscription; broadcast is enough to
// prove the shape).
import net from 'node:net';
import { spawn } from 'node:child_process';
import { unlinkSync, existsSync, appendFileSync } from 'node:fs';

const SOCK = process.argv[2];
const LOG = process.argv[3] || '/dev/null';
const log = (...a) => { try { appendFileSync(LOG, `[${new Date().toISOString()}] ${a.join(' ')}\n`); } catch {} };

if (existsSync(SOCK)) { try { unlinkSync(SOCK); } catch {} }

const srv = spawn('codex', ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'] });
srv.stderr.on('data', (c) => log('APPSRV-STDERR', c.toString().trim().slice(0, 300)));
srv.on('close', (code, sig) => { log('APPSRV CLOSED', code, sig); process.exit(1); });
log('broker up. app-server pid', srv.pid, 'sock', SOCK);

let nextUp = 1;                 // ids the broker uses toward the app-server
const route = new Map();        // upstreamId -> { sock, downstreamId }
const clients = new Set();
let initialized = false;

// Broker performs the ONE initialize handshake on behalf of everyone.
function upstream(method, params) {
  const id = nextUp++;
  srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return id;
}
const initId = upstream('initialize', { clientInfo: { name: 'agent-companion-broker', version: '1.0.0' } });

let ubuf = '';
srv.stdout.on('data', (chunk) => {
  ubuf += chunk.toString();
  const lines = ubuf.split('\n'); ubuf = lines.pop() || '';
  for (const l of lines) {
    if (!l.trim()) continue;
    let m; try { m = JSON.parse(l); } catch { log('UNPARSED', l.slice(0, 120)); continue; }
    if (m.id !== undefined && (m.result !== undefined || m.error !== undefined)) {
      if (m.id === initId) {
        srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} }) + '\n');
        initialized = true; log('app-server initialized by broker');
        continue;
      }
      const r = route.get(m.id); route.delete(m.id);
      if (r && !r.sock.destroyed) r.sock.write(JSON.stringify({ ...m, id: r.downstreamId }) + '\n');
      continue;
    }
    // notification or server->client request: fan out
    const payload = JSON.stringify(m) + '\n';
    for (const c of clients) if (!c.destroyed) c.write(payload);
  }
});

net.createServer((sock) => {
  clients.add(sock);
  log('client connected. total', clients.size);
  let buf = '';
  sock.on('data', (chunk) => {
    buf += chunk.toString();
    const lines = buf.split('\n'); buf = lines.pop() || '';
    for (const l of lines) {
      if (!l.trim()) continue;
      let m; try { m = JSON.parse(l); } catch { continue; }
      if (m.id === undefined) {
        // client notification (incl. its own `initialized`) — swallow the
        // handshake, forward anything else.
        if (m.method !== 'initialized') srv.stdin.write(JSON.stringify(m) + '\n');
        continue;
      }
      if (m.method === 'initialize') {
        // The broker already handshook upstream; answer locally so a client
        // never re-initializes a shared server.
        sock.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { brokered: true, appServerPid: srv.pid, initialized } }) + '\n');
        continue;
      }
      if (m.result !== undefined || m.error !== undefined) {
        // client answering a server->client request: pass straight through
        srv.stdin.write(JSON.stringify(m) + '\n');
        continue;
      }
      const up = nextUp++;
      route.set(up, { sock, downstreamId: m.id });
      srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: up, method: m.method, params: m.params }) + '\n');
    }
  });
  const drop = () => { clients.delete(sock); log('client gone. total', clients.size); };
  sock.on('close', drop); sock.on('error', drop);
}).listen(SOCK, () => log('listening on', SOCK));

process.on('SIGTERM', () => { try { srv.kill(); } catch {} try { unlinkSync(SOCK); } catch {} process.exit(0); });
