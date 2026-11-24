// `agent-companion ui`: the Ink layer. It prints the model's rows, forwards
// keys and the terminal size, and polls on a timer; the model owns state and
// layout. Plain .mjs with createElement, so there is no build step.
import { createElement as h, useEffect, useSyncExternalStore } from 'react';
import { Box, Text, render, useApp, useInput, usePaste, useWindowSize } from 'ink';
import { Model } from './model.mjs';

const POLL_MS = 250;
const SELECTED = '#1b2533';
// The mockup's five emphasis levels: bright bold, normal, colour only, dim, faint.
const STYLES = {
  title: { bold: true, color: 'whiteBright' }, normal: {},
  ok: { color: 'green' }, bad: { color: 'red' }, warn: { color: 'yellow' }, edit: { color: 'cyan' },
  dim: { color: 'gray' }, faint: { color: 'gray', dimColor: true },
};

export function Screen({ model }) {
  useSyncExternalStore(model.subscribe, model.getVersion);
  return h(Box, { flexDirection: 'column' }, model.render().map((row, i) => h(Text, { key: i, wrap: 'truncate' },
    row.map(([text, style, selected], j) => h(Text, { key: j, ...STYLES[style], ...(selected ? { backgroundColor: SELECTED } : {}) }, text)))));
}

function Live({ model, pollMs }) {
  const size = useWindowSize();
  const { exit } = useApp();
  model.exit = exit;
  useEffect(() => model.setSize({ columns: size.columns, rows: size.rows }), [size.columns, size.rows]);
  useInput((input, key) => model.key(input, key));
  // Bracketed paste: a pasted newline is text, never ⏎.
  usePaste(text => model.paste(text));
  useEffect(() => {
    const timer = setInterval(() => model.tick(), pollMs);
    return () => clearInterval(timer);
  }, [model, pollMs]);
  return h(Screen, { model });
}

export function run({ model, stdout = process.stdout, stdin = process.stdin, pollMs = POLL_MS, ...options } = {}) {
  model ??= new Model({ size: { columns: stdout.columns || 80, rows: stdout.rows || 24 } });
  // ctrl+c reaches the model: in a message box it clears the draft first.
  const app = render(h(Live, { model, pollMs }), { stdout, stdin, alternateScreen: true, exitOnCtrlC: false, ...options });
  return { model, app };
}

const USAGE = `usage: agent-companion ui

A live view of companion jobs from configured hosts: running
jobs first, then the last 24 hours. A running job's message box sends to its
bridge's inbox. Press ? in the list for keys.
`;
if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0] !== 'ui') {
    const help = ['help', '--help', '-h'].includes(args[0]) || (args.length === 2 && args[0] === 'ui' && args[1] === '--help');
    (help ? process.stdout : process.stderr).write(USAGE);
    process.exitCode = help ? 0 : 2;
  } else if (!process.stdout.isTTY || !process.stdin.isTTY) {
    process.stderr.write('agent-companion ui needs an interactive terminal\n');
    process.exitCode = 2;
  } else await run().app.waitUntilExit();
}
