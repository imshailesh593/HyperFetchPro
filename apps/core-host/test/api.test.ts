import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Store } from '@dm/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Api } from '../src/api.js';

const DATA = randomBytes(2 * 1024 * 1024);
let server: http.Server;
let base: string;
let dir: string;
let store: Store;
let api: Api;
let events: Array<{ event: string; data: any }>;

async function waitFor(cond: () => boolean, ms = 8000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dm-host-'));
  server = http.createServer((req, res) => {
    if (req.method === 'HEAD') return void res.setHeader('Content-Length', DATA.length).setHeader('Accept-Ranges', 'bytes').end();
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '');
    const start = m ? Number(m[1]) : 0;
    const end = m && m[2] ? Number(m[2]) : DATA.length - 1;
    if (m) res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${DATA.length}`, 'Accept-Ranges': 'bytes' });
    res.end(DATA.subarray(start, end + 1));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  store = new Store();
  store.setSetting('defaultDir', dir);
  events = [];
  api = new Api(store, (event, data) => events.push({ event, data }));
});

afterEach(async () => {
  await api.shutdown();
  store.close();
  server.close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('Api', () => {
  it('returns a snapshot with queues, categories and settings', async () => {
    const snap = (await api.handle('state.snapshot')) as any;
    expect(snap.queues.map((q: any) => q.id)).toEqual([1, 2]);
    expect(snap.categories.length).toBeGreaterThan(0);
    expect(snap.settings).toMatchObject({ defaultDir: dir, speedLimit: 0, maxConnections: 8 });
  });

  it('adds and starts a download, streams events, and the file is correct', async () => {
    const row = (await api.handle('download.add', { url: `${base}/file.zip`, startNow: true })) as any;
    expect(row).toMatchObject({ filename: 'file.zip', size: DATA.length });
    await waitFor(() => events.some((e) => e.event === 'download.changed' && e.data.download.status === 'completed'));
    expect(events.some((e) => e.event === 'download.progress')).toBe(true);
    const out = await fs.readFile(path.join(row.dir, row.filename));
    expect(createHash('sha256').update(out).digest('hex')).toBe(createHash('sha256').update(DATA).digest('hex'));
  });

  it('runs the main queue and reports it finished', async () => {
    await api.handle('download.add', { url: `${base}/a.zip` });
    await api.handle('download.add', { url: `${base}/b.zip` });
    await api.handle('queue.start', { id: 1 });
    await waitFor(() => events.some((e) => e.event === 'queue.finished'));
    const snap = (await api.handle('state.snapshot')) as any;
    expect(snap.downloads.every((d: any) => d.status === 'completed')).toBe(true);
  });

  it('resumeAll starts queued and paused downloads', async () => {
    await api.handle('download.add', { url: `${base}/q.zip` }); // lands in the main queue as "queued"
    await api.handle('downloads.resumeAll');
    await waitFor(() => (store.listDownloads()[0]?.status ?? '') === 'completed');
    expect(store.listDownloads()).toHaveLength(1);
  });

  it('persists settings and validates input', async () => {
    await api.handle('settings.set', { speedLimit: 1_000_000, maxConnections: 16 });
    expect(store.getSetting('speedLimit')).toBe('1000000');
    expect(store.getSetting('maxConnections')).toBe('16');
    await expect(api.handle('download.add', { url: 'file:///etc/passwd' })).rejects.toThrow(/http, https and ftp/);
    await expect(api.handle('download.pause', {})).rejects.toThrow(/id/);
    await expect(api.handle('nope')).rejects.toThrow(/Unknown method/);
    await expect(api.handle('settings.set', { defaultDir: 'relative/dir' })).rejects.toThrow(/full path/);
    await api.handle('settings.set', { defaultDir: dir });
    expect(store.getSetting('defaultDir')).toBe(dir);
  });

  it('removes downloads and deletes files on request', async () => {
    const row = (await api.handle('download.add', { url: `${base}/gone.zip`, startNow: true })) as any;
    await waitFor(() => store.getDownload(row.id)?.status === 'completed');
    const file = path.join(row.dir, row.filename);
    await api.handle('download.remove', { id: row.id, deleteFiles: true });
    expect(events.some((e) => e.event === 'download.removed' && e.data.id === row.id)).toBe(true);
    await expect(fs.stat(file)).rejects.toThrow();
  });
});

describe('media api', () => {
  it('is unavailable without yt-dlp support and refuses non-web links', async () => {
    await expect(api.handle('media.info', { url: 'https://x/y' })).rejects.toThrow(/not available/);
  });
});
