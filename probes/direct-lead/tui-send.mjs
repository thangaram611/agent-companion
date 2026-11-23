// Queue keystrokes for a running PTY probe. Usage: node tui-send.mjs RUN "text" (\r and \x1b escapes are decoded)
import fs from 'node:fs';
const [run, text] = process.argv.slice(2);
fs.appendFileSync(run + '/tui-input.jsonl', JSON.stringify({ text: JSON.parse('"' + text.replaceAll('"', '\\"') + '"') }) + '\n');
