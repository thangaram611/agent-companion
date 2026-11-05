import '../sandbox-home.mjs';
import { Records } from '../../bridge-server/controller/records.mjs';
const records = new Records({ dir: process.argv[2], log: () => {} });
process.send({ ready: true });
process.on('message', (message) => {
  try {
    const result = message.operation === 'begin' ? records.begin(message.record, 0) : records.writeResult(message.record);
    process.send({ ok: Boolean(result) });
  } catch (err) { process.send({ error: err.code || err.message }); }
  process.disconnect();
});
