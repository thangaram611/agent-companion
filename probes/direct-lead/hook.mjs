// Records every hook payload. Usage: node hook.mjs RUN_DIR
import fs from 'node:fs';
const run = process.argv[2];
const payload = fs.readFileSync(0, 'utf8');
let parsed; try { parsed = JSON.parse(payload); } catch { parsed = { raw: payload.slice(0, 2000) }; }
const t = Date.now();
// Prompts are kept whole in their own files; other big strings are shortened here (the stream has them).
if (parsed.hook_event_name === 'UserPromptSubmit' && typeof parsed.prompt === 'string') fs.writeFileSync(`${run}/prompt-${t}.txt`, parsed.prompt);
const trim = v => typeof v === 'string' && v.length > 600 ? v.slice(0, 300) + `…[${v.length} chars]…` + v.slice(-200)
  : Array.isArray(v) ? v.map(trim) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, trim(x)])) : v;
fs.appendFileSync(run + '/hooks.jsonl', JSON.stringify({ t, ...trim(parsed) }) + '\n');
