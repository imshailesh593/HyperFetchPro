import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Api } from './api.js';

/** Where other local programs (the browser native host) reach the running app. */
export function ipcPath(dataDir: string): string {
  // A custom data folder (DM_DATA_DIR: tests, portable copies) gets its own pipe, so it never meets the user's real app.
  const own = process.env.DM_DATA_DIR ? '.' + createHash('sha1').update(path.resolve(dataDir).toLowerCase()).digest('hex').slice(0, 8) : '';
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\DownloadManager.${os.userInfo().username}${own}`
    : path.join(dataDir, 'dm.sock');
}

export const TOKEN_FILE = 'ipc.token';

/** A video page the browser wants the app to offer for download (the user then picks a quality in the app). */
export interface MediaCaptureParams {
  url: string;
  referrer?: string;
  userAgent?: string;
  cookie?: string;
}

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
export function startIpcServer(
  api: Api,
  dataDir: string,
  onCapture?: (id: number) => void,
  pipe = ipcPath(dataDir),
  onMedia?: (params: MediaCaptureParams) => void,
) {
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
      const req = JSON.parse(line) as { token?: string; method?: string; params?: CaptureParams & MediaCaptureParams };
      if (req.token !== token) return { ok: false, error: 'unauthorized' };
      if (req.method === 'ping') return { ok: true, result: { pong: true } };
      if (req.method === 'media' && req.params) {
        const { url, referrer, userAgent, cookie } = req.params;
        if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return { ok: false, error: 'Only http and https links are supported' };
        if (!onMedia) return { ok: false, error: 'video capture is not available' };
        onMedia({
          url,
          referrer: typeof referrer === 'string' ? referrer : undefined,
          userAgent: typeof userAgent === 'string' ? userAgent : undefined,
          cookie: typeof cookie === 'string' && cookie ? cookie : undefined,
        });
        return { ok: true, result: {} };
      }
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
