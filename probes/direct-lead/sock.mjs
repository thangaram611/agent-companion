// Post one line to a probe session's own inbox socket and print whatever comes back.
// Usage: node sock.mjs RUN_DIR '<line>' [--no-auth]
import fs from 'node:fs';
import net from 'node:net';
const [run, line, flag] = process.argv.slice(2);
const { socket, token } = JSON.parse(fs.readFileSync(run + '/messaging.json', 'utf8'));
const conn = net.createConnection(socket);
let got = '';
conn.on('connect', () => { if (flag !== '--no-auth') conn.write(JSON.stringify({ type: 'auth', token }) + '\n'); conn.write(line + '\n'); });
conn.on('data', chunk => { got += chunk; });
conn.on('error', err => console.log('error:', err.message));
conn.on('close', () => { console.log('closed; received:', JSON.stringify(got.slice(0, 600))); process.exit(0); });
setTimeout(() => { console.log('timeout; received:', JSON.stringify(got.slice(0, 600))); conn.end(); }, 4000);
