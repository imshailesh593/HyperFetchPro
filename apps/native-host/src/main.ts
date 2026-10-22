import { readFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { ipcPath, TOKEN_FILE } from '../../core-host/src/ipc.js';

/**
 * Browser native-messaging host. The browser starts one per message and talks over stdio with
 * 4-byte little-endian length-prefixed JSON. We forward the request to the running app over its
 * local pipe and relay the answer. Only the extension ID listed in the manifest may launch us.
 */
const dataDir =
  process.env.DM_DATA_DIR ?? path.join(process.env.APPDATA ?? path.join(os.homedir(), '.config'), 'DownloadManager');

function reply(message: object): void {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length);
  process.stdout.write(Buffer.concat([head, body]));
}

function forward(method: string, params: unknown): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  return new Promise((resolve) => {
    let token: string;
    try {
      token = readFileSync(path.join(dataDir, TOKEN_FILE), 'utf8').trim();
    } catch {
      return resolve({ ok: false, error: 'app-not-running' });
    }
    const socket = net.connect(ipcPath(dataDir));
    const timer = setTimeout(() => (socket.destroy(), resolve({ ok: false, error: 'timeout' })), 15_000);
    let buf = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(JSON.stringify({ token, method, params }) + '\n'));
    socket.on('data', (d: string) => {
      buf += d;
      if (!buf.includes('\n')) return;
      clearTimeout(timer);
      socket.end();
      try {
        resolve(JSON.parse(buf));
      } catch {
        resolve({ ok: false, error: 'bad-reply' });
      }
    });
    socket.on('error', () => (clearTimeout(timer), resolve({ ok: false, error: 'app-not-running' })));
  });
}

let pending = Buffer.alloc(0);
process.stdin.on('data', (chunk: Buffer) => {
  pending = Buffer.concat([pending, chunk]);
  while (pending.length >= 4) {
    const len = pending.readUInt32LE(0);
    if (len > 1_000_000) process.exit(1);
    if (pending.length < 4 + len) return;
    const body = pending.subarray(4, 4 + len).toString('utf8');
    pending = pending.subarray(4 + len);
    let msg: { id?: number; method?: string; params?: unknown };
    try {
      msg = JSON.parse(body);
    } catch {
      continue;
    }
    void forward(msg.method ?? '', msg.params).then((r) => reply({ id: msg.id, ...r }));
  }
});
process.stdin.on('end', () => setTimeout(() => process.exit(0), 200));
