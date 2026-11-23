// Each joined session owns a private Unix socket. Its registration and socket
// are unique to this incarnation, even if Copilot restarts the same session.
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { join } from 'node:path';
import { writePrivateFileAtomic } from '../private-files.mjs';

const hash = session => createHash('sha256').update(session).digest('hex').slice(0, 24);
const timeout = 5000;

function registrations(runtime, session) {
  const dir = join(runtime, 'notices');
  let names;
  try { names = readdirSync(dir); }
  catch (err) { if (err.code === 'ENOENT') return []; throw err; }
  const rows = [];
  for (const name of names) {
    if (!name.endsWith('.json') || (session && !name.startsWith(hash(session) + '-'))) continue;
    try {
      const row = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      if (!session || row.session === session) rows.push(row);
    } catch { /* withdrawn during scan */ }
  }
  return rows.sort((a, b) => b.started - a.started);
}

export async function registeredSessions(runtime, session) {
  const live = await Promise.all(registrations(runtime, session).map(async row => {
    try { await requestRegistration(row); return true; }
    catch { return false; }
  }));
  return live.filter(Boolean).length;
}

export async function noticeRequest(runtime, session, notice) {
  const [row] = registrations(runtime, session);
  if (!row) throw new Error('Copilot notice extension has not joined');
  await requestRegistration(row, notice);
}

async function requestRegistration(row, notice) {
  // Exactly one request. An acknowledgement lost after session.send is ambiguous.
  await new Promise((resolve, reject) => {
    const req = request({ socketPath: row.socket, method: notice === undefined ? 'GET' : 'POST',
      path: '/' + encodeURIComponent(row.session), headers: { Authorization: 'Bearer ' + row.token },
      signal: AbortSignal.timeout(timeout), agent: false }, res => {
      res.resume();
      if (res.statusCode === 204) resolve();
      else reject(new Error('Copilot notice extension refused the request'));
    });
    req.once('error', reject);
    req.end(notice);
  });
}

export async function serveNotices(runtime, session) {
  const id = session.sessionId;
  const token = randomUUID();
  const dir = join(runtime, 'notices');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // A profile or TMPDIR can exceed sockaddr_un.sun_path on macOS. mkdtemp
  // creates a private directory even when /tmp is shared with other users.
  const privateDir = mkdtempSync('/tmp/ac-' + hash(id).slice(0, 8) + '-');
  const socket = join(privateDir, 'notice.sock');
  const file = join(dir, hash(id) + '-' + token + '.json');
  const server = createServer(async (req, res) => {
    const end = status => { res.writeHead(status); res.end(); };
    if (req.url !== '/' + encodeURIComponent(id) || req.headers.authorization !== 'Bearer ' + token) return end(403);
    if (req.method === 'GET') return end(204);
    if (req.method !== 'POST') return end(405);
    try {
      let text = '';
      req.setEncoding('utf8');
      for await (const chunk of req) {
        text += chunk;
        if (text.length > 65536) return end(413);
      }
      // The SDK has no cancellation guarantee once a send starts. Release
      // this request on deadline and leave the delivery outcome ambiguous.
      let timer;
      try {
        await Promise.race([session.send(text), new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Copilot send timed out')), timeout);
        })]);
      } finally { clearTimeout(timer); }
      end(204);
    } catch { end(503); }
  });
  server.setTimeout(timeout, client => client.destroy());
  const close = () => {
    server.close();
    rmSync(file, { force: true });
    rmSync(privateDir, { recursive: true, force: true });
  };
  try {
    server.listen(socket);
    await once(server, 'listening');
    writePrivateFileAtomic(file, JSON.stringify({ session: id, socket, token, pid: process.pid, started: Date.now() }));
    return close;
  } catch (err) { close(); throw err; }
}
