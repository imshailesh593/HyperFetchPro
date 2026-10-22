import { promises as fs } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Store } from '@dm/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Api } from '../src/api.js';
import { startIpcServer } from '../src/ipc.js';

let dir: string;
let store: Store;
let api: Api;
let server: http.Server;
let ipc: ReturnType<typeof startIpcServer>;
let seenHeaders: http.IncomingHttpHeaders = {};
const captured: number[] = [];

function call(msg: object): Promise<any> {
  return new Promise((resolve, reject) => {
    const s = net.connect(ipc.pipe, () => s.write(JSON.stringify(msg) + '\n'));
    s.setEncoding('utf8');
    s.once('data', (d: string) => (s.end(), resolve(JSON.parse(d))));
    s.once('error', reject);
  });
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dm-ipc-'));
  server = http.createServer((req, res) => {
    if (req.method !== 'HEAD') seenHeaders = req.headers;
    res.setHeader('Content-Length', 5).end(req.method === 'HEAD' ? undefined : 'hello');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  store = new Store();
  store.setSetting('defaultDir', dir);
  api = new Api(store, () => undefined);
  const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\dm-test-${Date.now()}` : path.join(dir, 's.sock');
  ipc = startIpcServer(api, dir, (id) => captured.push(id), pipe);
  await new Promise((r) => setTimeout(r, 50));
});

afterEach(async () => {
  await ipc.close();
  await api.shutdown();
  store.close();
  server.close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('ipc', () => {
  it('rejects a missing or wrong token', async () => {
    expect((await call({ method: 'ping' })).error).toBe('unauthorized');
    expect((await call({ token: 'nope', method: 'ping' })).error).toBe('unauthorized');
  });

  it('writes a token file only the app can read, matching the server token', async () => {
    expect(await fs.readFile(path.join(dir, 'ipc.token'), 'utf8')).toBe(ipc.token);
  });

  it('captures a download with browser headers', async () => {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/a.zip`;
    const r = await call({
      token: ipc.token,
      method: 'capture',
      params: { url, referrer: 'http://site/page', cookie: 'a=b', userAgent: 'UA/1' },
    });
    expect(r.ok).toBe(true);
    for (let i = 0; i < 200 && store.getDownload(r.result.id)?.status !== 'completed'; i++) await new Promise((x) => setTimeout(x, 20));
    expect(store.getDownload(r.result.id)?.status).toBe('completed');
    expect(seenHeaders).toMatchObject({ referer: 'http://site/page', cookie: 'a=b', 'user-agent': 'UA/1' });
    expect(captured).toContain(r.result.id);
  });

  it('refuses non-http links', async () => {
    const r = await call({ token: ipc.token, method: 'capture', params: { url: 'file:///c:/x' } });
    expect(r.ok).toBe(false);
  });
});
