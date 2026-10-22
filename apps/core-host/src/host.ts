import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { Media } from '@dm/media';
import { Store } from '@dm/store';
import { Api } from './api.js';
import { startIpcServer } from './ipc.js';

/**
 * Process entry point. Speaks newline-delimited JSON on stdio:
 *   in : {"id":1,"method":"state.snapshot","params":{}}
 *   out: {"id":1,"result":{...}}  |  {"id":1,"error":"message"}  |  {"event":"download.progress","data":{...}}
 * stdout carries only protocol lines; diagnostics go to stderr.
 */
const dataDir = process.env.DM_DATA_DIR ?? path.join(process.env.APPDATA ?? path.join(os.homedir(), '.config'), 'DownloadManager');
const store = new Store(path.join(dataDir, 'downloads.db'));

const send = (message: unknown): void => {
  process.stdout.write(JSON.stringify(message) + '\n');
};

const api = new Api(store, (event, data) => send({ event, data }), { media: new Media(dataDir) });

const ipc = startIpcServer(api, dataDir, (id) => send({ event: 'capture.added', data: { id } }));

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let req: { id?: number; method?: string; params?: Record<string, unknown> };
  try {
    req = JSON.parse(line);
  } catch {
    process.stderr.write(`bad json: ${line.slice(0, 200)}\n`);
    return;
  }
  const { id, method } = req;
  if (typeof id !== 'number' || typeof method !== 'string') return;
  api
    .handle(method, req.params)
    .then((result) => send({ id, result }))
    .catch((err: unknown) => send({ id, error: err instanceof Error ? err.message : String(err) }));
});

let closing = false;
async function close(): Promise<void> {
  if (closing) return;
  closing = true;
  await ipc.close();
  await api.shutdown().catch(() => undefined);
  store.close();
  process.exit(0);
}
rl.on('close', () => void close()); // the UI went away
process.on('SIGINT', () => void close());
process.on('SIGTERM', () => void close());

send({ event: 'host.ready', data: { pid: process.pid, dataDir } });
