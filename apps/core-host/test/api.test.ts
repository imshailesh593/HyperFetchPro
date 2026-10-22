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

describe('queues and categories api', () => {
  it('creates, validates, updates and deletes queues', async () => {
    const q = (await api.handle('queue.add', { name: 'Night', startTime: '02:00', stopTime: '06:30', days: 62, maxParallel: 3 })) as any;
    expect(q).toMatchObject({ name: 'Night', startTime: '02:00', stopTime: '06:30', days: 62, maxParallel: 3, running: false });
    expect(events.some((e) => e.event === 'queues.changed')).toBe(true);

    const u = (await api.handle('queue.update', { id: q.id, stopTime: null, afterAction: 'exit' })) as any;
    expect(u).toMatchObject({ stopTime: null, afterAction: 'exit', startTime: '02:00' });

    await expect(api.handle('queue.update', { id: q.id, startTime: '25:00' })).rejects.toThrow(/HH:MM/);
    await expect(api.handle('queue.update', { id: q.id, maxParallel: 0 })).rejects.toThrow(/between 1 and 10/);
    await expect(api.handle('queue.update', { id: q.id, days: 200 })).rejects.toThrow(/0 to 127/);
    await expect(api.handle('queue.update', { id: 999, maxParallel: 2 })).rejects.toThrow(/No such queue/);
    await expect(api.handle('queue.delete', { id: 1 })).rejects.toThrow(/main queues/);

    expect(((await api.handle('queue.list')) as any[]).map((x) => x.id)).toContain(q.id);
    expect(await api.handle('queue.delete', { id: q.id })).toEqual({ deleted: true });
  });

  it('manages categories', async () => {
    const c = (await api.handle('category.add', { name: 'Books', extensions: '.epub mobi, azw3' })) as any;
    expect(c.extensions).toEqual(['epub', 'mobi', 'azw3']);
    const u = (await api.handle('category.update', { id: c.id, saveDir: dir, name: 'Reading' })) as any;
    expect(u).toMatchObject({ name: 'Reading', saveDir: dir });
    await expect(api.handle('category.update', { id: c.id, saveDir: 'relative' })).rejects.toThrow(/full path/);
    expect(((await api.handle('category.update', { id: c.id, saveDir: '' })) as any).saveDir).toBeNull();
    expect(await api.handle('category.delete', { id: c.id })).toEqual({ deleted: true });
  });
});

describe('quota and repeat settings', () => {
  it('stores the download limit, reports it, and validates it', async () => {
    await api.handle('settings.set', { quotaMb: 40, quotaHours: 1 });
    const snap = (await api.handle('state.snapshot')) as any;
    expect(snap.settings).toMatchObject({ quotaMb: 40, quotaHours: 1 });
    expect(snap.quota).toMatchObject({ limitBytes: 40 * 1024 * 1024, windowMs: 3_600_000, blocked: false });
    expect(events.some((e) => e.event === 'quota.changed')).toBe(true);
    await expect(api.handle('settings.set', { quotaMb: -1 })).rejects.toThrow(/between 0 and/);
    await expect(api.handle('settings.set', { quotaHours: 0 })).rejects.toThrow(/0.1 and 720/);
    await api.handle('settings.set', { quotaMb: 0 });
    expect(((await api.handle('state.snapshot')) as any).quota.limitBytes).toBe(0);
  });

  it('validates the repeat interval', async () => {
    const q = (await api.handle('queue.add', { name: 'Sync', kind: 'sync', repeatMinutes: 30 })) as any;
    expect(q.repeatMinutes).toBe(30);
    expect(((await api.handle('queue.update', { id: q.id, repeatMinutes: null })) as any).repeatMinutes).toBeNull();
    await expect(api.handle('queue.update', { id: q.id, repeatMinutes: 0 })).rejects.toThrow(/1 and 1440/);
  });
});
