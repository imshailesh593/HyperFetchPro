import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Api } from './api.js';

/** Where other local programs (the browser native host) reach the running app. */
export function ipcPath(dataDir: string): string {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\DownloadManager.${os.userInfo().username}`
    : path.join(dataDir, 'dm.sock');
}

export const TOKEN_FILE = 'ipc.token';

export interface CaptureParams {
  url: string;
  filename?: string;
  referrer?: string;
  userAgent?: string;
  cookie?: string;
}

/**
 * Line-delimited JSON server. Every request must carry the token from `<dataDir>/ipc.token`,
 * which only the current user can read; that stops other local users and web pages.
 * Methods: `ping`, `capture` (adds and starts a download, returns the row).
 */
export function startIpcServer(api: Api, dataDir: string, onCapture?: (id: number) => void, pipe = ipcPath(dataDir)) {
  mkdirSync(dataDir, { recursive: true });
  const token = randomBytes(32).toString('hex');
  const tokenFile = path.join(dataDir, TOKEN_FILE);
  writeFileSync(tokenFile, token, { mode: 0o600 });
  if (process.platform !== 'win32') rmSync(pipe, { force: true });

  const server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    let buf = '';
    socket.on('data', (chunk: string) => {
      buf += chunk;
      if (buf.length > 1_000_000) return void socket.destroy();
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        void respond(line).then((out) => socket.write(JSON.stringify(out) + '\n'));
      }
    });
    socket.on('error', () => undefined);
  });

  async function respond(line: string): Promise<{ ok: boolean; result?: unknown; error?: string }> {
    try {
      const req = JSON.parse(line) as { token?: string; method?: string; params?: CaptureParams };
      if (req.token !== token) return { ok: false, error: 'unauthorized' };
      if (req.method === 'ping') return { ok: true, result: { pong: true } };
      if (req.method === 'capture' && req.params) {
        const p = req.params;
        const headers: Record<string, string> = {};
        if (p.referrer) headers.Referer = p.referrer;
        if (p.userAgent) headers['User-Agent'] = p.userAgent;
        if (p.cookie) headers.Cookie = p.cookie;
        const row = (await api.handle('download.add', {
          url: p.url,
          filename: p.filename,
          headers: Object.keys(headers).length ? headers : undefined,
          startNow: true,
        })) as { id: number };
        onCapture?.(row.id);
        return { ok: true, result: { id: row.id } };
      }
      return { ok: false, error: 'unknown method' };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  server.listen(pipe);
  if (process.platform !== 'win32') server.on('listening', () => chmodSync(pipe, 0o600));
  return {
    pipe,
    token,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        rmSync(tokenFile, { force: true });
      }),
  };
}
